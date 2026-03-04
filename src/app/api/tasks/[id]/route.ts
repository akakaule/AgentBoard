import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { emitEvent } from "@/lib/event-emitter";
import { z } from "zod/v4";
import {
  mergePullRequest,
  closePullRequest,
  cleanupWorktree,
  detectProvider,
} from "@/lib/git-operations";
import { syncLinkedIssueForTask } from "@/lib/issue-sync";

const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  criteria: z.string().optional(),
  repoUrl: z.string().optional(),
  status: z.enum(["todo", "ready", "in_progress", "review", "done", "failed"]).optional(),
  priority: z.number().int().min(1).max(3).optional(),
  position: z.number().int().optional(),
  error: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  costEstimate: z.number().optional(),
  tags: z.string().optional(),
  dependsOn: z.string().optional(),
  model: z.string().optional(),
  boardId: z.string().optional(),
  scheduledFor: z.string().nullable().optional(),
  cronExpression: z.string().optional(),
  recurring: z.boolean().optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  return NextResponse.json(task);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const { scheduledFor, ...rest } = updateTaskSchema.parse(body);

    // Fetch current task to detect status transitions
    const currentTask = await prisma.task.findUnique({ where: { id } });
    if (!currentTask) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Handle approval transition: review → done (merge PR)
    if (currentTask.status === "review" && rest.status === "done" && currentTask.prUrl) {
      const board = await prisma.board.findUnique({
        where: { id: currentTask.boardId },
        select: { repoPath: true, gitProvider: true },
      });
      if (board?.repoPath) {
        try {
          const provider = detectProvider(board.repoPath, board.gitProvider || undefined);
          mergePullRequest(currentTask.prUrl, board.repoPath, provider);
          // Clean up worktree after successful merge
          if (currentTask.worktreePath) {
            cleanupWorktree(board.repoPath, currentTask.worktreePath, currentTask.branchName || undefined);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : "Merge failed";
          return NextResponse.json(
            { error: `PR merge failed: ${errMsg}. Resolve conflicts on GitHub first.` },
            { status: 409 }
          );
        }
      }
    }

    // Handle rejection transition: review → failed (close PR)
    if (currentTask.status === "review" && rest.status === "failed" && currentTask.prUrl) {
      const board = await prisma.board.findUnique({
        where: { id: currentTask.boardId },
        select: { repoPath: true, gitProvider: true },
      });
      if (board?.repoPath) {
        const provider = detectProvider(board.repoPath, board.gitProvider || undefined);
        try {
          closePullRequest(currentTask.prUrl, board.repoPath, provider);
        } catch {
          // Best-effort: PR close failure shouldn't block rejection
        }
        if (currentTask.worktreePath) {
          try {
            cleanupWorktree(board.repoPath, currentTask.worktreePath, currentTask.branchName || undefined);
          } catch {
            // Best-effort cleanup
          }
        }
      }
    }

    const task = await prisma.task.update({
      where: { id },
      data: {
        ...rest,
        ...(scheduledFor !== undefined && {
          scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
        }),
      },
    });

    if (rest.status && rest.status !== currentTask.status) {
      syncLinkedIssueForTask(task).catch(() => {});
    }

    emitEvent({ type: "task:updated", taskId: task.id });
    return NextResponse.json(task);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", issues: error.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update task" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await prisma.task.delete({ where: { id } });
    emitEvent({ type: "task:updated", taskId: id });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete task" },
      { status: 500 }
    );
  }
}
