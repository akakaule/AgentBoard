import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { spawn } from "child_process";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const task = await prisma.task.findUnique({
    where: { id },
    select: { worktreePath: true },
  });

  if (!task) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  if (!task.worktreePath) {
    return NextResponse.json(
      { error: "Task has no worktree" },
      { status: 400 }
    );
  }

  const editorCommand = await getSetting("editorCommand");

  try {
    const proc = spawn(editorCommand, [task.worktreePath], {
      detached: true,
      stdio: "ignore",
      shell: true,
    });
    proc.unref();

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to open editor: ${err instanceof Error ? err.message : "Unknown error"}`,
      },
      { status: 500 }
    );
  }
}
