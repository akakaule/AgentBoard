import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { ensureDefaults } from "@/lib/ensure-defaults";
import { detectProvider } from "@/lib/git-operations";
import { importIssuesToBoard } from "@/lib/issue-sync";

const importSchema = z.object({
  boardId: z.string().optional().default("default"),
  limit: z.number().int().min(1).max(200).optional().default(50),
});

export async function POST(request: Request) {
  try {
    await ensureDefaults();
    const body = await request.json();
    const data = importSchema.parse(body);

    const board = await prisma.board.findUnique({
      where: { id: data.boardId },
    });
    if (!board) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }
    if (!board.repoPath) {
      return NextResponse.json(
        { error: "Board has no git repo configured" },
        { status: 400 }
      );
    }

    const provider = detectProvider(board.repoPath, board.gitProvider || undefined);
    const imported = await importIssuesToBoard(board, data.limit);
    return NextResponse.json({ success: true, provider, imported });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", issues: error.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import issues" },
      { status: 500 }
    );
  }
}
