"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { LogViewer } from "../logs/LogViewer";
import { GitDiffViewer } from "./GitDiffViewer";
import {
  useDeleteTask,
  useStopTask,
  useRetryTask,
  useUpdateTask,
  useTasksQuery,
} from "@/hooks/useTasksQuery";
import {
  PRIORITY_LABELS,
  PRIORITY_COLORS,
  STATUS_COLORS,
  TaskStatus,
} from "@/lib/types";
import { formatDuration } from "@/lib/utils";
import { tagColor } from "@/lib/tag-colors";
import { toast } from "sonner";
import { describeCron } from "@/lib/cron-parser";
import type { Task } from "@/generated/prisma/client";

const MODEL_OPTIONS = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

interface TaskCardDetailProps {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function EditableText({
  value,
  onSave,
  multiline = false,
  placeholder = "",
  className = "",
  disabled = false,
}: {
  value: string;
  onSave: (value: string) => void;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value) {
      onSave(trimmed);
    }
  }, [draft, value, onSave]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setDraft(value);
      setEditing(false);
    }
    if (e.key === "Enter" && !multiline) {
      commit();
    }
  };

  if (disabled) {
    return (
      <span className={className}>
        {value || <span className="text-muted-foreground italic">{placeholder || "Empty"}</span>}
      </span>
    );
  }

  if (editing) {
    if (multiline) {
      return (
        <Textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="min-h-[60px] text-sm"
          rows={3}
        />
      );
    }
    return (
      <Input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="text-sm"
      />
    );
  }

  return (
    <div
      className={`cursor-pointer rounded-md border border-transparent px-2 py-1 hover:border-border hover:bg-muted/50 ${className}`}
      onClick={() => setEditing(true)}
      title="Click to edit"
    >
      {value || <span className="text-muted-foreground italic">{placeholder || "Click to add..."}</span>}
    </div>
  );
}

export function TaskCardDetail({
  task,
  open,
  onOpenChange,
}: TaskCardDetailProps) {
  const deleteTask = useDeleteTask();
  const stopTask = useStopTask();
  const retryTask = useRetryTask();
  const updateTask = useUpdateTask();
  const { data: allTasks } = useTasksQuery();
  const [diffOpen, setDiffOpen] = useState(false);

  const isEditable =
    task.status === TaskStatus.TODO ||
    task.status === TaskStatus.READY ||
    task.status === TaskStatus.REVIEW ||
    task.status === TaskStatus.DONE ||
    task.status === TaskStatus.FAILED;

  const handleUpdate = useCallback(
    (field: string, value: string | number) => {
      updateTask.mutate(
        { id: task.id, [field]: value },
        {
          onSuccess: () => toast.success("Task updated"),
          onError: () => toast.error("Failed to update task"),
        }
      );
    },
    [task.id, updateTask]
  );

  const handleStop = () => {
    stopTask.mutate(task.id, {
      onSuccess: () => toast.success("Task stopped"),
      onError: () => toast.error("Failed to stop task"),
    });
  };

  const handleRetry = () => {
    retryTask.mutate(task.id, {
      onSuccess: () => {
        toast.success("Task queued for retry");
        onOpenChange(false);
      },
      onError: () => toast.error("Failed to retry task"),
    });
  };

  const handleDelete = () => {
    deleteTask.mutate(task.id, {
      onSuccess: () => {
        toast.success("Task deleted");
        onOpenChange(false);
      },
      onError: () => toast.error("Failed to delete task"),
    });
  };

  const handleApprove = (excludedFiles?: string[]) => {
    updateTask.mutate(
      {
        id: task.id,
        status: "done",
        ...(excludedFiles && excludedFiles.length > 0 && { excludedFiles }),
      },
      {
        onSuccess: () => toast.success(task.prUrl ? "Task approved & PR merged" : "Task approved"),
        onError: (err) => toast.error(err.message || "Failed to approve task"),
      }
    );
  };

  const handleOpenEditor = () => {
    fetch(`/api/tasks/${task.id}/open-editor`, { method: "POST" })
      .then(async (res) => {
        if (res.ok) {
          toast.success("Opening in editor...");
        } else {
          const data = await res.json().catch(() => ({}));
          toast.error(data.error || "Failed to open editor");
        }
      })
      .catch(() => toast.error("Failed to open editor"));
  };

  const handleReject = () => {
    updateTask.mutate(
      { id: task.id, status: "failed", error: "Rejected by user" },
      {
        onSuccess: () => toast.success(task.prUrl ? "Task rejected & PR closed" : "Task rejected"),
        onError: () => toast.error("Failed to reject task"),
      }
    );
  };

  const costDisplay =
    task.inputTokens > 0 || task.outputTokens > 0
      ? `${task.inputTokens.toLocaleString()} in / ${task.outputTokens.toLocaleString()} out` +
        (task.costEstimate > 0 ? ` (~$${task.costEstimate.toFixed(4)})` : "")
      : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-left">
            <EditableText
              value={task.title}
              onSave={(v) => handleUpdate("title", v)}
              disabled={!isEditable}
              placeholder="Task title"
              className="text-lg font-semibold"
            />
          </SheetTitle>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
          {/* Status & Priority */}
          <div className="flex items-center gap-2">
            <Badge
              variant="secondary"
              className={STATUS_COLORS[task.status]}
            >
              {task.status}
            </Badge>
            {isEditable ? (
              <Select
                value={String(task.priority)}
                onValueChange={(v) => handleUpdate("priority", parseInt(v))}
              >
                <SelectTrigger className="h-6 w-auto gap-1 border-0 px-2 text-xs">
                  <Badge
                    variant="outline"
                    className={PRIORITY_COLORS[task.priority]}
                  >
                    <SelectValue />
                  </Badge>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">High</SelectItem>
                  <SelectItem value="2">Medium</SelectItem>
                  <SelectItem value="3">Low</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Badge
                variant="outline"
                className={PRIORITY_COLORS[task.priority]}
              >
                {PRIORITY_LABELS[task.priority]}
              </Badge>
            )}
            {task.retryCount > 0 && (
              <span className="text-xs text-muted-foreground">
                Retries: {task.retryCount}/{task.maxRetries}
              </span>
            )}
          </div>

          {/* Timestamps */}
          <div className="space-y-1 text-xs text-muted-foreground">
            <div>Created: {new Date(task.createdAt).toLocaleString()}</div>
            {task.startedAt && (
              <div>Started: {new Date(task.startedAt).toLocaleString()}</div>
            )}
            {task.completedAt && (
              <div>
                Completed: {new Date(task.completedAt).toLocaleString()}
                {task.startedAt && (
                  <span>
                    {" "}
                    ({formatDuration(new Date(task.startedAt), new Date(task.completedAt))})
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Token/Cost Info */}
          {costDisplay && (
            <div className="text-xs text-muted-foreground">
              Tokens: {costDisplay}
            </div>
          )}

          {/* Summary */}
          {task.summary && (
            <>
              <Separator />
              <div>
                <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                  Summary
                </h4>
                <div className="whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm">
                  {task.summary}
                </div>
              </div>
            </>
          )}

          {/* Description */}
          <Separator />
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              Description
            </h4>
            <EditableText
              value={task.description}
              onSave={(v) => handleUpdate("description", v)}
              disabled={!isEditable}
              multiline
              placeholder="Add a description..."
              className="whitespace-pre-wrap text-sm"
            />
          </div>

          {/* Criteria */}
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              Acceptance Criteria
            </h4>
            <EditableText
              value={task.criteria}
              onSave={(v) => handleUpdate("criteria", v)}
              disabled={!isEditable}
              multiline
              placeholder="Add acceptance criteria..."
              className="whitespace-pre-wrap text-sm"
            />
          </div>

          {/* Working Directory */}
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              Working Directory
            </h4>
            <EditableText
              value={task.repoUrl}
              onSave={(v) => handleUpdate("repoUrl", v)}
              disabled={!isEditable}
              placeholder="Defaults to workspaces/<taskId>"
              className="text-xs font-mono"
            />
          </div>

          {/* Git Branch & PR */}
          {(task.branchName || task.prUrl) && (
            <div>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                Git
              </h4>
              <div className="space-y-1 rounded-md bg-muted/30 p-3">
                {task.branchName && (
                  <div className="text-xs">
                    <span className="text-muted-foreground">Branch: </span>
                    <span className="font-mono">{task.branchName}</span>
                  </div>
                )}
                {task.prUrl && (
                  <div className="text-xs">
                    <span className="text-muted-foreground">PR: </span>
                    <a
                      href={task.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 underline hover:text-blue-300"
                    >
                      {task.prUrl}
                    </a>
                  </div>
                )}
                {task.worktreePath && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 h-7 text-xs"
                    onClick={handleOpenEditor}
                  >
                    Open in Editor
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Tags */}
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              Tags
            </h4>
            {isEditable ? (
              <EditableText
                value={task.tags}
                onSave={(v) => handleUpdate("tags", v)}
                placeholder="Comma-separated tags..."
                className="text-sm"
              />
            ) : (
              <div className="flex flex-wrap gap-1 px-2 py-1">
                {task.tags ? (
                  task.tags
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .map((tag) => (
                      <span
                        key={tag}
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tagColor(tag)}`}
                      >
                        {tag}
                      </span>
                    ))
                ) : (
                  <span className="text-muted-foreground italic text-sm">No tags</span>
                )}
              </div>
            )}
          </div>

          {/* Dependencies */}
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              Dependencies
            </h4>
            {isEditable ? (
              <EditableText
                value={(() => {
                  try {
                    const ids: string[] = task.dependsOn ? JSON.parse(task.dependsOn) : [];
                    return ids.join(", ");
                  } catch {
                    return task.dependsOn;
                  }
                })()}
                onSave={(v) => {
                  const ids = v.split(",").map((s) => s.trim()).filter(Boolean);
                  handleUpdate("dependsOn", ids.length > 0 ? JSON.stringify(ids) : "");
                }}
                placeholder="Comma-separated task IDs..."
                className="text-sm font-mono"
              />
            ) : null}
            {(() => {
              try {
                const depIds: string[] = task.dependsOn ? JSON.parse(task.dependsOn) : [];
                if (depIds.length === 0) return null;
                return (
                  <div className="mt-1 space-y-1 px-2">
                    {depIds.map((id) => {
                      const dep = allTasks?.find((t) => t.id === id);
                      return (
                        <div key={id} className="flex items-center gap-2 text-xs">
                          <Badge
                            variant="secondary"
                            className={`text-[10px] ${dep ? STATUS_COLORS[dep.status] : ""}`}
                          >
                            {dep ? dep.status : "unknown"}
                          </Badge>
                          <span className="truncate">
                            {dep ? dep.title : id}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              } catch {
                return null;
              }
            })()}
          </div>

          {/* Model */}
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              Model
            </h4>
            {isEditable ? (
              <Select
                value={task.model || ""}
                onValueChange={(v) => handleUpdate("model", v === "default" ? "" : v)}
              >
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue placeholder="Default" />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value || "default"} value={opt.value || "default"}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="px-2 py-1 text-sm capitalize">
                {task.model || "Default"}
              </span>
            )}
          </div>

          {/* Schedule */}
          {(task.scheduledFor || task.cronExpression || task.recurring || task.sourceTaskId) && (
            <div>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                Schedule
              </h4>
              <div className="space-y-2 rounded-md bg-muted/30 p-3">
                {task.scheduledFor && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Run at: </span>
                    {isEditable ? (
                      <input
                        type="datetime-local"
                        defaultValue={new Date(task.scheduledFor).toISOString().slice(0, 16)}
                        onChange={(e) => {
                          if (e.target.value) {
                            handleUpdate("scheduledFor", new Date(e.target.value).toISOString());
                          }
                        }}
                        className="ml-1 rounded border border-input bg-transparent px-1 py-0.5 text-sm"
                      />
                    ) : (
                      <span>{new Date(task.scheduledFor).toLocaleString()}</span>
                    )}
                  </div>
                )}
                {task.cronExpression && (
                  <div className="text-sm">
                    <span className="text-muted-foreground">Cron: </span>
                    {isEditable ? (
                      <EditableText
                        value={task.cronExpression}
                        onSave={(v) => handleUpdate("cronExpression", v)}
                        placeholder="Cron expression"
                        className="inline font-mono text-sm"
                      />
                    ) : (
                      <span className="font-mono">{task.cronExpression}</span>
                    )}
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({describeCron(task.cronExpression)})
                    </span>
                  </div>
                )}
                {task.recurring && (
                  <Badge variant="outline" className="text-xs border-purple-500/30 bg-purple-500/10 text-purple-400">
                    Recurring Template
                  </Badge>
                )}
                {task.sourceTaskId && (
                  <div className="text-xs text-muted-foreground">
                    Cloned from: <span className="font-mono">{task.sourceTaskId.slice(0, 12)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Error */}
          {task.error && (
            <div className="rounded-md bg-red-500/10 p-3">
              <h4 className="mb-1 text-xs font-medium text-red-400">Error</h4>
              <p className="text-sm text-red-300">{task.error}</p>
            </div>
          )}

          <Separator />

          {/* Logs */}
          <div className="flex flex-col">
            <h4 className="mb-2 text-xs font-medium text-muted-foreground">
              Agent Logs
            </h4>
            <LogViewer
              taskId={task.id}
              isActive={task.status === TaskStatus.IN_PROGRESS}
            />
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-2">
            {task.status === TaskStatus.REVIEW && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => handleApprove()}
                  disabled={updateTask.isPending}
                  className="bg-green-600 hover:bg-green-700"
                >
                  {task.prUrl ? "Approve & Merge" : "Approve"}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleReject}
                  disabled={updateTask.isPending}
                >
                  Reject
                </Button>
              </>
            )}
            {task.status === TaskStatus.IN_PROGRESS && (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleStop}
                disabled={stopTask.isPending}
              >
                Stop Agent
              </Button>
            )}
            {task.status === TaskStatus.FAILED && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handleRetry}
                disabled={retryTask.isPending}
              >
                Retry
              </Button>
            )}
            {(task.status === TaskStatus.DONE ||
              task.status === TaskStatus.FAILED ||
              task.status === TaskStatus.REVIEW) &&
              (task.repoUrl || task.worktreePath) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDiffOpen(true)}
              >
                View Diff
              </Button>
            )}
            {(task.status === TaskStatus.TODO ||
              task.status === TaskStatus.DONE ||
              task.status === TaskStatus.FAILED) && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={handleDelete}
                disabled={deleteTask.isPending}
              >
                Delete
              </Button>
            )}
          </div>
        </div>

        <GitDiffViewer
          taskId={task.id}
          open={diffOpen}
          onOpenChange={setDiffOpen}
          reviewMode={task.status === TaskStatus.REVIEW}
          onApproveWithSelection={(excludedFiles) => {
            handleApprove(excludedFiles);
            setDiffOpen(false);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}
