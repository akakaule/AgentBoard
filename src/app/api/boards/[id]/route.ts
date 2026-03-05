import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { z } from "zod/v4";
import { validateGitRepo } from "@/lib/git-operations";
import { getWorktreePool } from "@/lib/worktree-pool";

const updateBoardSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  repoPath: z.string().optional(),
  baseBranch: z.string().optional(),
  gitProvider: z.string().optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const board = await prisma.board.findUnique({ where: { id } });
  if (!board) {
    return NextResponse.json({ error: "Board not found" }, { status: 404 });
  }
  return NextResponse.json(board);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const data = updateBoardSchema.parse(body);

    // Validate repoPath if being set
    if (data.repoPath !== undefined && data.repoPath !== "") {
      const validation = validateGitRepo(data.repoPath);
      if (!validation.valid) {
        return NextResponse.json(
          { error: `Invalid git repository: ${validation.error}` },
          { status: 400 }
        );
      }
    }

    const board = await prisma.board.update({
      where: { id },
      data,
    });

    // Invalidate worktree pool if repoPath changed
    if (data.repoPath !== undefined) {
      getWorktreePool().invalidateBoard(id).catch(() => {});
    }

    return NextResponse.json(board);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", issues: error.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update board" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (id === "default") {
    return NextResponse.json(
      { error: "Cannot delete the default board" },
      { status: 400 }
    );
  }

  // Check if board has tasks
  const taskCount = await prisma.task.count({ where: { boardId: id } });
  if (taskCount > 0) {
    return NextResponse.json(
      { error: `Board has ${taskCount} task(s). Move or delete them first.` },
      { status: 400 }
    );
  }

  try {
    await prisma.board.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete board" },
      { status: 500 }
    );
  }
}
