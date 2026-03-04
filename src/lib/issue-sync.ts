import type { Task, Board } from "@/generated/prisma/client";
import { prisma } from "./db";
import { emitEvent } from "./event-emitter";
import {
  type GitProvider,
  commentOnIssue,
  detectProvider,
  getRemoteUrl,
  listRemoteIssues,
  updateIssueState,
} from "./git-operations";

export interface LinkedIssue {
  provider: GitProvider;
  issueId: string;
}

export function parseLinkedIssue(tags: string): LinkedIssue | null {
  if (!tags) return null;
  const parts = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^issue:(github|azuredevops):(\d+)$/i);
    if (match) {
      return {
        provider: match[1].toLowerCase() as GitProvider,
        issueId: match[2],
      };
    }
  }
  return null;
}

export function ensureIssueTag(
  tags: string,
  provider: GitProvider,
  issueId: string
): string {
  const current = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const marker = `issue:${provider}:${issueId}`;
  if (!current.includes(marker)) current.push(marker);
  return current.join(", ");
}

function mapRemoteStateToTaskStatus(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized.includes("closed") || normalized.includes("resolved") || normalized.includes("done")) {
    return "done";
  }
  return "todo";
}

export async function resolveBoardForGitHubRepo(
  fullName: string
): Promise<Board | null> {
  const boards = await prisma.board.findMany({
    where: { repoPath: { not: "" } },
  });
  const hint = fullName.toLowerCase();
  for (const board of boards) {
    try {
      const provider = detectProvider(board.repoPath, board.gitProvider || undefined);
      if (provider !== "github") continue;
      const remote = getRemoteUrl(board.repoPath).toLowerCase();
      if (remote.includes(`/${hint}`) || remote.includes(`:${hint}`)) {
        return board;
      }
    } catch {
      // skip invalid git repo paths
    }
  }
  return null;
}

export async function resolveBoardForAzureRepo(
  projectName: string,
  repoName: string
): Promise<Board | null> {
  const boards = await prisma.board.findMany({
    where: { repoPath: { not: "" } },
  });
  const project = projectName.toLowerCase();
  const repo = repoName.toLowerCase();
  for (const board of boards) {
    try {
      const provider = detectProvider(board.repoPath, board.gitProvider || undefined);
      if (provider !== "azuredevops") continue;
      const remote = getRemoteUrl(board.repoPath).toLowerCase();
      if (
        remote.includes(`/${project}/_git/${repo}`) ||
        remote.endsWith(`/${repo}`) ||
        remote.endsWith(`:${repo}`)
      ) {
        return board;
      }
    } catch {
      // skip invalid git repo paths
    }
  }
  return null;
}

export async function upsertTaskFromIssue(input: {
  boardId: string;
  provider: GitProvider;
  issueId: string;
  title: string;
  description: string;
  url: string;
  state: string;
  tags?: string;
}): Promise<Task> {
  const issueTag = `issue:${input.provider}:${input.issueId}`;
  const existing = await prisma.task.findFirst({
    where: {
      boardId: input.boardId,
      tags: { contains: issueTag },
    },
  });
  const status = mapRemoteStateToTaskStatus(input.state);

  if (existing) {
    const updated = await prisma.task.update({
      where: { id: existing.id },
      data: {
        title: input.title,
        description: input.description || "",
        repoUrl: input.url || existing.repoUrl,
        status,
        tags: ensureIssueTag(input.tags || existing.tags || "", input.provider, input.issueId),
      },
    });
    emitEvent({ type: "task:updated", taskId: updated.id });
    return updated;
  }

  const maxPos = await prisma.task.aggregate({
    _max: { position: true },
    where: { boardId: input.boardId, status },
  });

  const created = await prisma.task.create({
    data: {
      title: input.title,
      description: input.description || "",
      repoUrl: input.url || "",
      boardId: input.boardId,
      status,
      position: (maxPos._max.position ?? 0) + 1,
      tags: ensureIssueTag(input.tags || "issue", input.provider, input.issueId),
    },
  });
  emitEvent({ type: "task:updated", taskId: created.id });
  return created;
}

export async function importIssuesToBoard(
  board: Board,
  limit = 50
): Promise<number> {
  if (!board.repoPath) throw new Error("Board has no repo path configured");
  const provider = detectProvider(board.repoPath, board.gitProvider || undefined);
  const issues = listRemoteIssues(board.repoPath, provider, limit);
  let count = 0;
  for (const issue of issues) {
    await upsertTaskFromIssue({
      boardId: board.id,
      provider,
      issueId: issue.id,
      title: issue.title || `Issue #${issue.id}`,
      description: issue.body || "",
      url: issue.url || "",
      state: issue.state || "open",
      tags: issue.tags ? `issue, ${issue.tags}` : "issue",
    });
    count += 1;
  }
  return count;
}

export async function syncLinkedIssueForTask(task: Task): Promise<void> {
  const linked = parseLinkedIssue(task.tags || "");
  if (!linked) return;

  const board = await prisma.board.findUnique({
    where: { id: task.boardId },
    select: { repoPath: true, gitProvider: true },
  });
  if (!board?.repoPath) return;

  const provider = detectProvider(board.repoPath, board.gitProvider || undefined);
  if (provider !== linked.provider) return;

  const shouldClose = task.status === "done";
  updateIssueState(board.repoPath, linked.issueId, shouldClose, provider);
  commentOnIssue(
    board.repoPath,
    linked.issueId,
    `AgentBoard task "${task.title}" is now "${task.status}".`,
    provider
  );
}

export async function buildIssueReferenceFooter(
  task: Task,
  provider: GitProvider
): Promise<string> {
  const linked = parseLinkedIssue(task.tags || "");
  if (!linked || linked.provider !== provider) return "";
  return provider === "github" ? `\n\nCloses #${linked.issueId}` : `\n\nAB#${linked.issueId}`;
}

export async function linkPullRequestToIssue(
  task: Task,
  prUrl: string,
  board: { repoPath: string; gitProvider: string }
): Promise<void> {
  const linked = parseLinkedIssue(task.tags || "");
  if (!linked || !board.repoPath) return;
  const provider = detectProvider(board.repoPath, board.gitProvider || undefined);
  if (linked.provider !== provider) return;
  commentOnIssue(
    board.repoPath,
    linked.issueId,
    `Related pull request: ${prUrl}`,
    provider
  );
}
