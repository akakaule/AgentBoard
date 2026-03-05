import { prisma } from "./db";
import { cleanupWorktree, slugify, git } from "./git-operations";
import { getMaxConcurrent } from "./settings";
import path from "path";
import crypto from "crypto";

interface PoolEntry {
  worktreePath: string;
  branchName: string;
  repoPath: string;
}

interface BoardPool {
  entries: PoolEntry[];
  refilling: boolean;
}

class WorktreePool {
  private pools = new Map<string, BoardPool>();
  private targetSize = 2;

  async initialize(): Promise<void> {
    this.targetSize = await getMaxConcurrent();

    const boards = await prisma.board.findMany({
      where: { repoPath: { not: "" } },
      select: { id: true, repoPath: true, baseBranch: true },
    });

    for (const board of boards) {
      if (!board.repoPath) continue;
      this.pools.set(board.id, { entries: [], refilling: false });
      this.refill(board.id, board.repoPath, board.baseBranch || "main").catch(
        () => {}
      );
    }
  }

  lease(
    boardId: string,
    repoPath: string,
    taskId: string,
    taskTitle: string,
    _baseBranch: string
  ): { worktreePath: string; branchName: string } | null {
    const pool = this.pools.get(boardId);
    if (!pool || pool.entries.length === 0) return null;

    const entry = pool.entries.shift()!;
    const dirName = `${slugify(taskTitle)}-${taskId.slice(0, 8)}`;
    const newBranchName = `task/${dirName}`;

    try {
      // Rename the pool branch to the task branch (local-only, fast)
      git(`branch -m "${entry.branchName}" "${newBranchName}"`, repoPath);
    } catch {
      // If rename fails, return null to fall back to on-demand creation
      // Clean up the orphaned entry
      cleanupWorktree(repoPath, entry.worktreePath, entry.branchName);
      return null;
    }

    // Trigger async refill
    this.refill(boardId, repoPath, _baseBranch).catch(() => {});

    return { worktreePath: entry.worktreePath, branchName: newBranchName };
  }

  async drain(): Promise<void> {
    for (const [, pool] of this.pools) {
      for (const entry of pool.entries) {
        try {
          cleanupWorktree(entry.repoPath, entry.worktreePath, entry.branchName);
        } catch {
          // Best-effort cleanup
        }
      }
      pool.entries = [];
    }
    this.pools.clear();
  }

  async invalidateBoard(boardId: string): Promise<void> {
    const pool = this.pools.get(boardId);
    if (!pool) return;

    for (const entry of pool.entries) {
      try {
        cleanupWorktree(entry.repoPath, entry.worktreePath, entry.branchName);
      } catch {
        // Best-effort
      }
    }
    pool.entries = [];
    this.pools.delete(boardId);
  }

  private async refill(
    boardId: string,
    repoPath: string,
    baseBranch: string
  ): Promise<void> {
    let pool = this.pools.get(boardId);
    if (!pool) {
      pool = { entries: [], refilling: false };
      this.pools.set(boardId, pool);
    }
    if (pool.refilling) return;
    if (pool.entries.length >= this.targetSize) return;

    pool.refilling = true;
    try {
      // Fetch once for all new entries
      try {
        git("fetch origin", repoPath, 15000);
      } catch {
        // Offline — continue with local state
      }

      // Determine start point
      let startPoint = `origin/${baseBranch}`;
      try {
        git(`rev-parse --verify "${startPoint}"`, repoPath);
      } catch {
        startPoint = baseBranch;
        try {
          git(`rev-parse --verify "${startPoint}"`, repoPath);
        } catch {
          startPoint = "HEAD";
        }
      }

      const needed = this.targetSize - pool.entries.length;
      for (let i = 0; i < needed; i++) {
        try {
          const uuid8 = crypto.randomUUID().slice(0, 8);
          const branchName = `pool/${uuid8}`;
          const worktreePath = path.join(
            repoPath,
            ".worktrees",
            `pool-${uuid8}`
          );

          git(
            `worktree add "${worktreePath}" -b "${branchName}" "${startPoint}"`,
            repoPath
          );

          pool.entries.push({ worktreePath, branchName, repoPath });
        } catch {
          // Failed to create this entry, continue with what we have
          break;
        }
      }
    } finally {
      pool.refilling = false;
    }
  }
}

// Singleton via globalThis (survives HMR)
const globalForPool = globalThis as unknown as {
  worktreePool: WorktreePool | undefined;
};

export function getWorktreePool(): WorktreePool {
  if (!globalForPool.worktreePool) {
    globalForPool.worktreePool = new WorktreePool();
  }
  return globalForPool.worktreePool;
}
