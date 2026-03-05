import { NextResponse } from "next/server";
import { ensureDefaults } from "@/lib/ensure-defaults";
import {
  resolveBoardForGitHubRepo,
  upsertTaskFromIssue,
} from "@/lib/issue-sync";

function checkAuth(request: Request): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true;
  return request.headers.get("X-Webhook-Secret") === secret;
}

export async function POST(request: Request) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureDefaults();
    const body = await request.json();
    const action = String(body.action || "");

    if (!["opened", "edited", "reopened", "closed"].includes(action)) {
      return NextResponse.json({ message: `Ignored action: ${action || "unknown"}` }, { status: 200 });
    }

    const issue = (body.issue || body.pull_request) as {
      number?: number;
      title?: string;
      body?: string;
      html_url?: string;
      state?: string;
    } | undefined;
    const repository = body.repository as { full_name?: string } | undefined;
    if (!issue?.number || !issue.title) {
      return NextResponse.json(
        { error: "No issue number/title found in payload" },
        { status: 400 }
      );
    }

    const board = repository?.full_name
      ? await resolveBoardForGitHubRepo(repository.full_name)
      : null;
    const task = await upsertTaskFromIssue({
      boardId: board?.id || "default",
      provider: "github",
      issueId: String(issue.number),
      title: issue.title,
      description: issue.body || "",
      url: issue.html_url || "",
      state: issue.state || (action === "closed" ? "closed" : "open"),
      tags: body.pull_request ? "pr, issue" : "issue",
    });

    return NextResponse.json({ success: true, taskId: task.id });
  } catch {
    return NextResponse.json(
      { error: "Failed to process GitHub webhook" },
      { status: 500 }
    );
  }
}
