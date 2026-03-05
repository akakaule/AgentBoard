import path from "path";
import { mkdirSync } from "fs";
import { prisma } from "./db";
import { AgentProcess } from "./agent-process";
import { emitEvent } from "./event-emitter";
import { getMaxConcurrent } from "./settings";
import { getScheduler } from "./scheduler";
import { fireIntegrations } from "./integration-dispatcher";
import {
  createWorktreeForTask,
  commitAndPush,
  createPullRequest,
  mergePullRequest,
  cleanupWorktree,
  cleanupOrphanedWorktrees,
  detectProvider,
} from "./git-operations";
import { getWorktreePool } from "./worktree-pool";
import {
  buildIssueReferenceFooter,
  linkPullRequestToIssue,
  syncLinkedIssueForTask,
} from "./issue-sync";

const POLL_INTERVAL = 5000;

class AgentDispatcher {
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeProcesses = new Map<string, AgentProcess>();
  private maxConcurrent = 2;

  async start() {
    if (this.running) return;
    this.running = true;

    // Load settings
    this.maxConcurrent = await getMaxConcurrent();

    // Check for orphaned in_progress tasks on startup
    await this.cleanOrphans();

    // Start polling
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL);
    this.poll(); // immediate first poll

    // Pre-allocate worktree pool
    getWorktreePool().initialize().catch(() => {});

    // Start task scheduler
    getScheduler().start();

    emitEvent({ type: "dispatcher:status", running: true });
  }

  stop() {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Drain worktree pool
    getWorktreePool().drain().catch(() => {});

    // Stop task scheduler
    getScheduler().stop();

    emitEvent({ type: "dispatcher:status", running: false });
  }

  getStatus() {
    return {
      running: this.running,
      activeTasks: this.activeProcesses.size,
      maxConcurrent: this.maxConcurrent,
    };
  }

  async setMaxConcurrent(value: number) {
    this.maxConcurrent = Math.max(1, Math.min(value, 10));
  }

  stopTask(taskId: string) {
    const proc = this.activeProcesses.get(taskId);
    if (proc) {
      proc.kill();
      this.activeProcesses.delete(taskId);
    }
  }

  private async cleanOrphans() {
    const orphans = await prisma.task.findMany({
      where: { status: "in_progress" },
    });

    for (const task of orphans) {
      if (!this.activeProcesses.has(task.id)) {
        // Check if PID is still alive
        if (task.agentPid) {
          try {
            process.kill(task.agentPid, 0); // signal 0 = check if alive
            continue; // still running, skip
          } catch {
            // process is dead, mark as failed
          }
        }

        await prisma.task.update({
          where: { id: task.id },
          data: {
            status: "failed",
            error: "Orphaned process (server restarted)",
            agentPid: null,
          },
        });
        emitEvent({ type: "task:updated", taskId: task.id });
      }
    }

    // Prune orphaned git worktrees for boards with repoPath
    try {
      const boards = await prisma.board.findMany({
        where: { repoPath: { not: "" } },
        select: { repoPath: true },
      });
      for (const board of boards) {
        cleanupOrphanedWorktrees(board.repoPath);
      }
    } catch {
      // Non-critical
    }
  }

  private async poll() {
    if (!this.running) return;
    if (this.activeProcesses.size >= this.maxConcurrent) return;

    const slotsAvailable = this.maxConcurrent - this.activeProcesses.size;
    const tasks = await prisma.task.findMany({
      where: { status: "ready" },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      take: slotsAvailable * 3, // fetch extra to account for blocked tasks
    });

    // Filter out tasks whose dependencies are not all done
    const eligible: typeof tasks = [];
    for (const task of tasks) {
      if (task.dependsOn) {
        try {
          const depIds: string[] = JSON.parse(task.dependsOn);
          if (depIds.length > 0) {
            const deps = await prisma.task.findMany({
              where: { id: { in: depIds } },
              select: { id: true, status: true },
            });
            const allDone = depIds.every((id) => {
              const dep = deps.find((d) => d.id === id);
              return dep && dep.status === "done";
            });
            if (!allDone) continue; // skip blocked task
          }
        } catch {
          // Invalid JSON in dependsOn, treat as no dependencies
        }
      }
      eligible.push(task);
    }

    for (const task of eligible) {
      if (this.activeProcesses.size >= this.maxConcurrent) break;
      await this.executeTask(task.id);
    }
  }

  private async executeTask(taskId: string) {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return;

    // Fetch board to check for git repo configuration
    const board = await prisma.board.findUnique({
      where: { id: task.boardId },
      select: { repoPath: true, baseBranch: true, gitProvider: true },
    });

    // Resolve working directory: use repoUrl if set, otherwise create a workspace
    let workDir = task.repoUrl || "";
    let worktreePath = "";
    let branchName = "";

    // If board has a repoPath and task doesn't override with repoUrl, create a worktree
    if (board?.repoPath && !task.repoUrl) {
      try {
        // Try pool first for instant startup, fall back to on-demand creation
        const baseBranch = board.baseBranch || "main";
        const poolResult = getWorktreePool().lease(
          task.boardId,
          board.repoPath,
          taskId,
          task.title,
          baseBranch
        );
        const result = poolResult ?? createWorktreeForTask(
          board.repoPath,
          taskId,
          task.title,
          baseBranch
        );
        workDir = result.worktreePath;
        worktreePath = result.worktreePath;
        branchName = result.branchName;

        // Save worktree info on the task
        await prisma.task.update({
          where: { id: taskId },
          data: { worktreePath, branchName },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Worktree creation failed";
        await prisma.taskLog.create({
          data: { taskId, stream: "system", content: `Git worktree setup failed: ${errMsg}. Falling back to repo directory.` },
        });
        // Fall back to the board's repo path directly (no worktree isolation)
        workDir = board.repoPath;
      }
    }

    if (!workDir) {
      workDir = path.join(process.cwd(), "workspaces", taskId);
      mkdirSync(workDir, { recursive: true });
    }

    // Fetch board memories to inject into prompt
    let memorySection = "";
    try {
      const memories = await prisma.memory.findMany({
        where: { boardId: task.boardId },
        orderBy: { updatedAt: "desc" },
        take: 20,
      });
      if (memories.length > 0) {
        const lines = memories.map((m) => `- ${m.key}: ${m.value}`).join("\n");
        memorySection = `\n\n## Project Knowledge Base\nThe following knowledge has been accumulated from previous tasks:\n${lines}`;
      }
    } catch {
      // Non-critical: proceed without memories
    }

    // Build prompt from task details
    let prompt = `You are an autonomous AI agent. Complete the following task without asking questions.
Work in the current directory: ${workDir}`;
    if (branchName) {
      prompt += `\nYou are working on branch: ${branchName}`;
      prompt += `\nDo NOT create new branches or switch branches. Stay on the current branch.`;
      prompt += `\nDo NOT commit changes — the platform will handle git operations automatically.`;
    }
    prompt += `\n\nTask: ${task.title}`;
    if (task.description) {
      prompt += `\n\nDescription:\n${task.description}`;
    }
    if (task.criteria) {
      prompt += `\n\nAcceptance Criteria:\n${task.criteria}`;
    }
    if (memorySection) {
      prompt += memorySection;
    }
    prompt += `\n\nDo not ask clarifying questions. Execute the task to completion.`;

    const agentProcess = new AgentProcess(taskId);
    this.activeProcesses.set(taskId, agentProcess);

    try {
      const pid = await agentProcess.start(prompt, workDir, task.model || undefined);

      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: "in_progress",
          agentPid: pid ?? null,
          startedAt: new Date(),
        },
      });
      emitEvent({ type: "task:updated", taskId });

      agentProcess.on("complete", async (usage: { inputTokens: number; outputTokens: number; costEstimate: number }) => {
        this.activeProcesses.delete(taskId);

        // Check if task requires approval (has "approval:required" tag)
        const completedTask = await prisma.task.findUnique({ where: { id: taskId } });
        const needsApproval = completedTask?.tags
          ?.split(",")
          .map((t) => t.trim())
          .includes("approval:required");

        // Git workflow: commit, push, and create PR if task has a worktree
        let prUrl = "";
        if (completedTask?.worktreePath && completedTask.branchName && board?.repoPath) {
          try {
            const provider = detectProvider(board.repoPath, board.gitProvider || undefined);
            const issueFooter = await buildIssueReferenceFooter(
              completedTask,
              provider
            );
            commitAndPush(
              completedTask.worktreePath,
              completedTask.branchName,
              `[AgentBoard] ${task.title}`
            );
            prUrl = createPullRequest(
              completedTask.worktreePath,
              task.title,
              `Automated PR created by AgentBoard.\n\nTask: ${task.title}\n${task.description || ""}${issueFooter}`,
              board.baseBranch || "main",
              provider
            );
            try {
              await linkPullRequestToIssue(completedTask, prUrl, {
                repoPath: board.repoPath,
                gitProvider: board.gitProvider || "",
              });
            } catch {
              // Best-effort issue comment
            }
            await prisma.taskLog.create({
              data: { taskId, stream: "system", content: `PR created: ${prUrl}` },
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : "Git operation failed";
            await prisma.taskLog.create({
              data: { taskId, stream: "system", content: `Git post-completion failed: ${errMsg}` },
            });
            // Don't fail the task — the work is done, git ops are best-effort
          }
        }

        // Auto-merge if no approval required; otherwise send to review
        let finalStatus: string = needsApproval ? "review" : "done";
        if (!needsApproval && prUrl && completedTask?.worktreePath && completedTask.branchName && board?.repoPath) {
          try {
            const provider = detectProvider(board.repoPath, board.gitProvider || undefined);
            mergePullRequest(prUrl, board.repoPath, provider);
            cleanupWorktree(board.repoPath, completedTask.worktreePath, completedTask.branchName);
            await prisma.taskLog.create({
              data: { taskId, stream: "system", content: `PR auto-merged: ${prUrl}` },
            });
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : "Auto-merge failed";
            await prisma.taskLog.create({
              data: { taskId, stream: "system", content: `Auto-merge failed, sending to review: ${errMsg}` },
            });
            finalStatus = "review"; // fall back so user can handle manually
          }
        }
        const updatedTask = await prisma.task.update({
          where: { id: taskId },
          data: {
            status: finalStatus,
            agentPid: null,
            completedAt: new Date(),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costEstimate: usage.costEstimate,
            ...(prUrl && { prUrl }),
          },
        });
        syncLinkedIssueForTask(updatedTask).catch(() => {});
        emitEvent({ type: "task:updated", taskId });

        // Fire outbound integrations
        fireIntegrations(`task:${finalStatus}`, {
          id: task.id,
          title: task.title,
          status: finalStatus,
          boardId: task.boardId,
        }).catch(() => {});

        // Generate summary and extract memories asynchronously
        this.generateSummary(taskId).catch(() => {});
        this.extractMemory(taskId, task.boardId).catch(() => {});
      });

      agentProcess.on("error", async (error: Error, usage: { inputTokens: number; outputTokens: number; costEstimate: number }) => {
        this.activeProcesses.delete(taskId);

        const currentTask = await prisma.task.findUnique({
          where: { id: taskId },
        });

        if (
          currentTask &&
          currentTask.retryCount < currentTask.maxRetries
        ) {
          // Auto-retry
          const retriedTask = await prisma.task.update({
            where: { id: taskId },
            data: {
              status: "todo",
              agentPid: null,
              error: error.message,
              retryCount: { increment: 1 },
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costEstimate: usage.costEstimate,
            },
          });
          syncLinkedIssueForTask(retriedTask).catch(() => {});
        } else {
          const failedTask = await prisma.task.update({
            where: { id: taskId },
            data: {
              status: "failed",
              agentPid: null,
              error: error.message,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costEstimate: usage.costEstimate,
            },
          });
          syncLinkedIssueForTask(failedTask).catch(() => {});

          // Fire outbound integrations for failure
          fireIntegrations("task:failed", {
            id: taskId,
            title: task.title,
            status: "failed",
            boardId: task.boardId,
            error: error.message,
          }).catch(() => {});
        }
        emitEvent({ type: "task:updated", taskId });
      });
    } catch (error) {
      this.activeProcesses.delete(taskId);
      await prisma.task.update({
        where: { id: taskId },
        data: {
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : "Failed to start agent",
          agentPid: null,
        },
      });
      emitEvent({ type: "task:updated", taskId });
    }
  }

  private async generateSummary(taskId: string) {
    // Fetch the last N logs for the task
    const logs = await prisma.taskLog.findMany({
      where: { taskId, stream: "stdout" },
      orderBy: { timestamp: "desc" },
      take: 100,
    });

    if (logs.length === 0) return;

    const logText = logs
      .reverse()
      .map((l) => l.content)
      .join("\n")
      .slice(-8000); // limit to ~8k chars

    const prompt = `Summarize what this AI agent did in 3-5 concise bullet points. Focus on actions taken and outcomes. Be specific about files changed, commands run, or decisions made.\n\nAgent logs:\n${logText}`;

    try {
      const { spawn } = await import("child_process");

      const env = { ...process.env };
      delete env.CLAUDECODE;
      for (const key of Object.keys(env)) {
        if (key.startsWith("CLAUDE_")) delete env[key];
      }

      const proc = spawn("claude", ["-p", "--model", "haiku"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });

      proc.stdin?.write(prompt);
      proc.stdin?.end();

      let output = "";
      proc.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
      });

      await new Promise<void>((resolve) => {
        proc.on("close", async (code) => {
          if (code === 0 && output.trim()) {
            await prisma.task.update({
              where: { id: taskId },
              data: { summary: output.trim() },
            });
            emitEvent({ type: "task:updated", taskId });
          }
          resolve();
        });
        proc.on("error", () => resolve());
        // Timeout after 30 seconds
        setTimeout(() => {
          try { proc.kill(); } catch {}
          resolve();
        }, 30000);
      });
    } catch {
      // Summary generation is best-effort
    }
  }

  private async extractMemory(taskId: string, boardId: string) {
    const logs = await prisma.taskLog.findMany({
      where: { taskId, stream: "stdout" },
      orderBy: { timestamp: "desc" },
      take: 100,
    });

    if (logs.length === 0) return;

    const logText = logs
      .reverse()
      .map((l) => l.content)
      .join("\n")
      .slice(-8000);

    const prompt = `Extract reusable project knowledge from these agent logs as JSON key-value pairs. Only include stable, reusable facts (conventions, file paths, patterns). Return JSON: {"memories": [{"key": "...", "value": "..."}]}\n\nAgent logs:\n${logText}`;

    try {
      const { spawn } = await import("child_process");

      const env = { ...process.env };
      delete env.CLAUDECODE;
      for (const key of Object.keys(env)) {
        if (key.startsWith("CLAUDE_")) delete env[key];
      }

      const proc = spawn("claude", ["-p", "--model", "haiku"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });

      proc.stdin?.write(prompt);
      proc.stdin?.end();

      let output = "";
      proc.stdout?.on("data", (data: Buffer) => {
        output += data.toString();
      });

      await new Promise<void>((resolve) => {
        proc.on("close", async (code) => {
          if (code === 0 && output.trim()) {
            try {
              // Extract JSON from output (handle markdown code blocks)
              let jsonStr = output.trim();
              const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
              if (jsonMatch) jsonStr = jsonMatch[1].trim();

              const parsed = JSON.parse(jsonStr);
              if (parsed.memories && Array.isArray(parsed.memories)) {
                for (const mem of parsed.memories) {
                  if (mem.key && mem.value) {
                    await prisma.memory.upsert({
                      where: {
                        boardId_key: { boardId, key: String(mem.key) },
                      },
                      update: {
                        value: String(mem.value),
                        source: "agent",
                        sourceTaskId: taskId,
                      },
                      create: {
                        boardId,
                        key: String(mem.key),
                        value: String(mem.value),
                        source: "agent",
                        sourceTaskId: taskId,
                      },
                    });
                  }
                }
                emitEvent({ type: "memory:updated", boardId });
              }
            } catch {
              // JSON parse failure is non-critical
            }
          }
          resolve();
        });
        proc.on("error", () => resolve());
        setTimeout(() => {
          try { proc.kill(); } catch {}
          resolve();
        }, 30000);
      });
    } catch {
      // Memory extraction is best-effort
    }
  }
}

// Singleton via globalThis (survives HMR)
const globalForDispatcher = globalThis as unknown as {
  dispatcher: AgentDispatcher | undefined;
};

export function getDispatcher(): AgentDispatcher {
  if (!globalForDispatcher.dispatcher) {
    globalForDispatcher.dispatcher = new AgentDispatcher();
  }
  return globalForDispatcher.dispatcher;
}
