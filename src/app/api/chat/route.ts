import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { prisma } from "@/lib/db";
import { z } from "zod/v4";

const chatSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().min(1),
    })
  ).min(1),
  boardId: z.string().optional().default("default"),
});

const SYSTEM_PROMPT = `You are a planning assistant for AgentBoard, a task management system where AI agents execute tasks autonomously.

Your job is to help users break down their goals into concrete, actionable tasks that an AI coding agent can execute independently.

When you have enough information, produce a task plan. Each task should be specific enough for an agent to execute without human intervention.

When you output a plan, end your response with a TASK_PROPOSALS block in exactly this format:

TASK_PROPOSALS
[
  {
    "title": "Short task title",
    "description": "Detailed description of what the agent should do",
    "criteria": "Specific acceptance criteria - how to verify the task is done",
    "priority": 2,
    "tags": "tag1, tag2"
  }
]
END_TASK_PROPOSALS

Rules:
- priority: 1 = high, 2 = medium, 3 = low
- tags: comma-separated string
- If the user's goal is too vague, ask clarifying questions instead of proposing tasks
- Tasks should be ordered by dependency (earlier tasks first)
- Each task should be independently executable by a coding agent
- Include clear acceptance criteria for each task
- Keep task descriptions focused and actionable`;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = chatSchema.parse(body);
    const { messages, boardId } = parsed;

    // Fetch board to get repoPath
    let repoPath = "";
    try {
      const board = await prisma.board.findUnique({
        where: { id: boardId },
        select: { repoPath: true },
      });
      if (board?.repoPath) repoPath = board.repoPath;
    } catch {
      // Non-critical
    }

    // Fetch board memories for context
    let memoryContext = "";
    try {
      const memories = await prisma.memory.findMany({
        where: { boardId },
        take: 50,
      });
      if (memories.length > 0) {
        memoryContext = "\n\nProject knowledge base:\n" +
          memories.map((m) => `- ${m.key}: ${m.value}`).join("\n");
      }
    } catch {
      // Non-critical, continue without memories
    }

    // Build prompt: system prompt + memory context + conversation history
    let fullSystemPrompt = SYSTEM_PROMPT + memoryContext;
    if (repoPath) {
      fullSystemPrompt += `\n\nYou have access to the project codebase at: ${repoPath}\nExplore the codebase to understand the project structure, existing patterns, and conventions before proposing tasks. This helps you create more specific, actionable tasks.`;
    }
    const conversationParts: string[] = [
      `<system>${fullSystemPrompt}</system>`,
    ];
    for (const msg of messages) {
      const tag = msg.role === "user" ? "human" : "assistant";
      conversationParts.push(`<${tag}>${msg.content}</${tag}>`);
    }
    const prompt = conversationParts.join("\n\n");

    // Strip CLAUDECODE env vars (same pattern as agent-process.ts)
    const env = { ...process.env };
    delete env.CLAUDECODE;
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDE_")) {
        delete env[key];
      }
    }

    const proc = spawn("claude", ["-p", "--output-format", "stream-json", "--verbose"], {
      env,
      cwd: repoPath || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    proc.stdin?.write(prompt);
    proc.stdin?.end();

    // Handle abort
    const abortHandler = () => {
      try {
        if (process.platform === "win32" && proc.pid) {
          const { execSync } = require("child_process");
          execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
        } else {
          proc.kill("SIGTERM");
        }
      } catch {
        // already dead
      }
    };
    request.signal.addEventListener("abort", abortHandler);

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const send = (data: object) => {
          controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
        };

        proc.stdout?.on("data", (data: Buffer) => {
          const text = data.toString();
          for (const line of text.split("\n").filter(Boolean)) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === "assistant" && parsed.message?.content) {
                for (const block of parsed.message.content) {
                  if (block.type === "text" && block.text) {
                    send({ type: "text", content: block.text });
                  }
                }
              } else if (parsed.type === "result" && parsed.result) {
                send({ type: "text", content: parsed.result });
              }
            } catch {
              // Not JSON, skip
            }
          }
        });

        proc.stderr?.on("data", () => {
          // Ignore stderr
        });

        proc.on("close", () => {
          send({ type: "done" });
          controller.close();
          request.signal.removeEventListener("abort", abortHandler);
        });

        proc.on("error", (err) => {
          send({ type: "error", content: err.message });
          controller.close();
          request.signal.removeEventListener("abort", abortHandler);
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.issues }, { status: 400 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
