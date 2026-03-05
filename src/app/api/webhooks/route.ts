import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { prisma } from "@/lib/db";
import { ensureDefaults } from "@/lib/ensure-defaults";
import { emitEvent } from "@/lib/event-emitter";
import {
  resolveBoardForGitHubRepo,
  upsertTaskFromIssue,
} from "@/lib/issue-sync";
import { detectProvider } from "@/lib/git-operations";

const directTaskSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional().default(""),
  criteria: z.string().optional().default(""),
  repoUrl: z.string().optional().default(""),
  priority: z.number().int().min(1).max(3).optional().default(2),
  tags: z.string().optional().default(""),
  model: z.string().optional().default(""),
  boardId: z.string().optional().default("default"),
});

function checkAuth(request: Request): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true;
  return request.headers.get("X-Webhook-Secret") === secret;
}

function getAzureField(
  resource: Record<string, unknown>,
  fieldName: string
): string {
  const fields = (resource.fields || {}) as Record<string, unknown>;
  const direct = fields[fieldName];
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") {
    const fromObject = direct as { newValue?: unknown; value?: unknown };
    if (typeof fromObject.newValue === "string") return fromObject.newValue;
    if (typeof fromObject.value === "string") return fromObject.value;
  }
  const revisionFields = (resource.revision as { fields?: Record<string, unknown> } | undefined)?.fields || {};
  const revisionValue = revisionFields[fieldName];
  return typeof revisionValue === "string" ? revisionValue : "";
}

async function resolveAzureBoardFromRequest(
  request: Request
): Promise<string> {
  const headerBoardId = request.headers.get("X-Board-Id");
  if (headerBoardId) return headerBoardId;

  const boards = await prisma.board.findMany({
    where: { repoPath: { not: "" } },
    orderBy: { createdAt: "asc" },
  });
  for (const board of boards) {
    try {
      const provider = detectProvider(board.repoPath, board.gitProvider || undefined);
      if (provider === "azuredevops") return board.id;
    } catch {
      // skip invalid board path
    }
  }
  return "default";
}

export async function POST(request: Request) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await ensureDefaults();
    const body = await request.json();

    // GitHub issues / PR webhooks
    if (
      body.action &&
      body.repository &&
      (body.issue || body.pull_request)
    ) {
      const action = String(body.action);
      if (!["opened", "edited", "reopened", "closed"].includes(action)) {
        return NextResponse.json({ message: `Ignored action: ${action}` }, { status: 200 });
      }

      const issue = (body.issue || body.pull_request) as {
        number?: number;
        title?: string;
        body?: string;
        html_url?: string;
        state?: string;
      };
      const repository = body.repository as { full_name?: string };

      if (!issue.title || !issue.number) {
        return NextResponse.json({ error: "Missing issue number or title" }, { status: 400 });
      }

      const board = repository.full_name
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
    }

    // Azure DevOps work item webhooks
    if (body.eventType && body.resource && String(body.eventType).startsWith("workitem.")) {
      const resource = body.resource as Record<string, unknown>;
      const issueId = resource.id;
      if (typeof issueId !== "number" && typeof issueId !== "string") {
        return NextResponse.json({ error: "Missing work item id" }, { status: 400 });
      }

      const title = getAzureField(resource, "System.Title");
      if (!title) {
        return NextResponse.json({ error: "Missing work item title" }, { status: 400 });
      }

      const description = getAzureField(resource, "System.Description");
      const state = getAzureField(resource, "System.State") || "Active";
      const url =
        ((resource._links as { html?: { href?: string } } | undefined)?.html?.href ||
          (typeof resource.url === "string" ? resource.url : "")) as string;
      const boardId = await resolveAzureBoardFromRequest(request);

      const task = await upsertTaskFromIssue({
        boardId,
        provider: "azuredevops",
        issueId: String(issueId),
        title,
        description,
        url,
        state,
        tags: "issue, azure",
      });
      return NextResponse.json({ success: true, taskId: task.id });
    }

    // Direct task format
    const data = directTaskSchema.parse(body);
    const maxPos = await prisma.task.aggregate({
      _max: { position: true },
      where: { status: "todo", boardId: data.boardId },
    });
    const task = await prisma.task.create({
      data: {
        ...data,
        position: (maxPos._max.position ?? 0) + 1,
      },
    });
    emitEvent({ type: "task:updated", taskId: task.id });
    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", issues: error.issues },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to process webhook" },
      { status: 500 }
    );
  }
}
