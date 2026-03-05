"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCreateTask } from "@/hooks/useTasksQuery";
import { toast } from "sonner";

interface TaskProposal {
  title: string;
  description: string;
  criteria: string;
  priority: number;
  tags: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  displayContent?: string;
  proposals?: TaskProposal[];
  addedIndices?: Set<number>;
}

interface ChatPlannerPanelProps {
  boardId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function parseProposals(text: string): { displayText: string; proposals: TaskProposal[] | null } {
  const regex = /TASK_PROPOSALS\s*\n?\s*(\[[\s\S]*?\])\s*\n?\s*END_TASK_PROPOSALS/;
  const match = text.match(regex);
  if (!match) return { displayText: text, proposals: null };

  try {
    const proposals = JSON.parse(match[1]) as TaskProposal[];
    const displayText = text.replace(regex, "").trim();
    return { displayText, proposals };
  } catch {
    return { displayText: text, proposals: null };
  }
}

const PRIORITY_LABELS: Record<number, { label: string; className: string }> = {
  1: { label: "High", className: "border-red-500/30 bg-red-500/10 text-red-400" },
  2: { label: "Medium", className: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400" },
  3: { label: "Low", className: "border-green-500/30 bg-green-500/10 text-green-400" },
};

function TaskProposalCard({
  proposal,
  index,
  added,
  onAdd,
}: {
  proposal: TaskProposal;
  index: number;
  added: boolean;
  onAdd: (index: number) => void;
}) {
  const priority = PRIORITY_LABELS[proposal.priority] || PRIORITY_LABELS[2];
  const tags = proposal.tags
    ?.split(",")
    .map((t) => t.trim())
    .filter(Boolean) || [];

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-medium leading-tight">{proposal.title}</h4>
        <Badge variant="outline" className={`shrink-0 text-[10px] ${priority.className}`}>
          {priority.label}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground line-clamp-2">{proposal.description}</p>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Badge key={tag} variant="outline" className="text-[10px]">
              {tag}
            </Badge>
          ))}
        </div>
      )}
      <Button
        size="sm"
        variant={added ? "ghost" : "outline"}
        className="w-full text-xs"
        disabled={added}
        onClick={() => onAdd(index)}
      >
        {added ? "Added" : "Add to Board"}
      </Button>
    </div>
  );
}

export function ChatPlannerPanel({ boardId, open, onOpenChange }: ChatPlannerPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamBuffer, setStreamBuffer] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const createTask = useCreateTask();

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamBuffer]);

  const handleAddProposal = useCallback(
    (messageIndex: number, proposalIndex: number) => {
      const msg = messages[messageIndex];
      if (!msg?.proposals?.[proposalIndex]) return;

      const proposal = msg.proposals[proposalIndex];
      createTask.mutate(
        {
          title: proposal.title,
          description: proposal.description,
          criteria: proposal.criteria || "",
          priority: proposal.priority || 2,
          tags: proposal.tags || "",
          boardId,
        },
        {
          onSuccess: () => {
            setMessages((prev) =>
              prev.map((m, i) => {
                if (i !== messageIndex) return m;
                const newAdded = new Set(m.addedIndices);
                newAdded.add(proposalIndex);
                return { ...m, addedIndices: newAdded };
              })
            );
            toast.success(`Added: ${proposal.title}`);
          },
          onError: () => toast.error("Failed to add task"),
        }
      );
    },
    [messages, boardId, createTask]
  );

  const handleAddAll = useCallback(
    (messageIndex: number) => {
      const msg = messages[messageIndex];
      if (!msg?.proposals) return;

      msg.proposals.forEach((proposal, idx) => {
        if (msg.addedIndices?.has(idx)) return;
        createTask.mutate(
          {
            title: proposal.title,
            description: proposal.description,
            criteria: proposal.criteria || "",
            priority: proposal.priority || 2,
            tags: proposal.tags || "",
            boardId,
          },
          {
            onSuccess: () => {
              setMessages((prev) =>
                prev.map((m, i) => {
                  if (i !== messageIndex) return m;
                  const newAdded = new Set(m.addedIndices);
                  newAdded.add(idx);
                  return { ...m, addedIndices: newAdded };
                })
              );
            },
          }
        );
      });
      toast.success("Adding all tasks...");
    },
    [messages, boardId, createTask]
  );

  const sendMessage = useCallback(async () => {
    const content = input.trim();
    if (!content || streaming) return;

    const userMessage: Message = { role: "user", content };
    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInput("");
    setStreaming(true);
    setStreamBuffer("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updatedMessages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          boardId,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Chat request failed: ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.type === "text") {
              fullText += data.content;
              setStreamBuffer(fullText);
            } else if (data.type === "done") {
              // Handled after loop
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      // Parse proposals from full text
      const { displayText, proposals } = parseProposals(fullText);
      const assistantMessage: Message = {
        role: "assistant",
        content: fullText,
        displayContent: displayText,
        proposals: proposals || undefined,
        addedIndices: new Set(),
      };
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        toast.error("Chat failed: " + (err as Error).message);
        // Add error as assistant message
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "Sorry, something went wrong. Please try again.",
          },
        ]);
      }
    } finally {
      setStreaming(false);
      setStreamBuffer("");
      abortRef.current = null;
    }
  }, [input, streaming, messages, boardId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  const handleClear = useCallback(() => {
    if (streaming && abortRef.current) {
      abortRef.current.abort();
    }
    setMessages([]);
    setStreamBuffer("");
    setInput("");
  }, [streaming]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-xl p-0">
        <SheetHeader className="px-6 pt-6 pb-2">
          <div className="flex items-center justify-between">
            <SheetTitle>Chat Planner</SheetTitle>
            {messages.length > 0 && (
              <Button variant="ghost" size="sm" onClick={handleClear}>
                Clear
              </Button>
            )}
          </div>
        </SheetHeader>

        {/* Messages */}
        <ScrollArea className="flex-1 min-h-0">
          <div ref={scrollRef} className="flex flex-col gap-4 px-6 py-4">
            {messages.length === 0 && !streaming && (
              <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
                <div className="text-4xl mb-4">💬</div>
                <h3 className="text-sm font-medium mb-1">Plan your tasks with AI</h3>
                <p className="text-xs max-w-[280px]">
                  Describe what you want to build and I&apos;ll break it down into actionable tasks for the board.
                </p>
              </div>
            )}

            {messages.map((msg, msgIdx) => (
              <div
                key={msgIdx}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  }`}
                >
                  <div className="whitespace-pre-wrap break-words">
                    {msg.displayContent ?? msg.content}
                  </div>
                  {msg.proposals && msg.proposals.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium opacity-70">
                          {msg.proposals.length} task{msg.proposals.length > 1 ? "s" : ""} proposed
                        </span>
                        {msg.proposals.length > 1 && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs h-6"
                            onClick={() => handleAddAll(msgIdx)}
                            disabled={
                              msg.addedIndices?.size === msg.proposals!.length
                            }
                          >
                            {msg.addedIndices?.size === msg.proposals!.length
                              ? "All Added"
                              : "Add All"}
                          </Button>
                        )}
                      </div>
                      {msg.proposals.map((proposal, propIdx) => (
                        <TaskProposalCard
                          key={propIdx}
                          proposal={proposal}
                          index={propIdx}
                          added={msg.addedIndices?.has(propIdx) || false}
                          onAdd={() => handleAddProposal(msgIdx, propIdx)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Streaming indicator */}
            {streaming && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-muted">
                  <div className="whitespace-pre-wrap break-words">
                    {streamBuffer || (
                      <span className="text-muted-foreground italic">Thinking...</span>
                    )}
                    <span className="inline-block w-1.5 h-4 bg-foreground/70 ml-0.5 animate-pulse align-text-bottom" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Input */}
        <div className="border-t border-border px-6 py-4">
          <div className="flex gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Describe what you want to build..."
              className="min-h-[44px] max-h-[120px] resize-none text-sm"
              rows={1}
              disabled={streaming}
            />
            <Button
              size="sm"
              onClick={sendMessage}
              disabled={!input.trim() || streaming}
              className="self-end shrink-0"
            >
              Send
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1.5">
            Enter to send, Shift+Enter for newline
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
