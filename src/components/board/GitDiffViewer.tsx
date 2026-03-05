"use client";

import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";

interface GitDiffViewerProps {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reviewMode?: boolean;
  onApproveWithSelection?: (excludedFiles: string[]) => void;
}

interface DiffFile {
  header: string;
  hunks: string[];
}

function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = diff.split("\n");
  let currentFile: DiffFile | null = null;
  let currentHunk: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (currentFile) {
        if (currentHunk.length > 0) {
          currentFile.hunks.push(currentHunk.join("\n"));
        }
        files.push(currentFile);
      }
      currentFile = { header: line, hunks: [] };
      currentHunk = [];
    } else if (line.startsWith("@@")) {
      if (currentFile && currentHunk.length > 0) {
        currentFile.hunks.push(currentHunk.join("\n"));
      }
      currentHunk = [line];
    } else if (
      currentFile &&
      !currentFile.hunks.length &&
      currentHunk.length === 0 &&
      (line.startsWith("---") ||
        line.startsWith("+++") ||
        line.startsWith("index ") ||
        line.startsWith("new file") ||
        line.startsWith("deleted file") ||
        line.startsWith("old mode") ||
        line.startsWith("new mode") ||
        line.startsWith("similarity index") ||
        line.startsWith("rename from") ||
        line.startsWith("rename to") ||
        line.startsWith("Binary files"))
    ) {
      currentFile.header += "\n" + line;
    } else {
      currentHunk.push(line);
    }
  }

  if (currentFile) {
    if (currentHunk.length > 0) {
      currentFile.hunks.push(currentHunk.join("\n"));
    }
    files.push(currentFile);
  }

  return files;
}

function extractFilename(header: string): string {
  const match = header.match(/diff --git a\/(.+?) b\//);
  return match ? match[1] : header;
}

function DiffLine({ line }: { line: string }) {
  let className = "whitespace-pre font-mono text-xs leading-5 px-2";
  if (line.startsWith("+")) {
    className += " bg-green-500/15 text-green-300";
  } else if (line.startsWith("-")) {
    className += " bg-red-500/15 text-red-300";
  } else if (line.startsWith("@@")) {
    className += " bg-cyan-500/10 text-cyan-400";
  } else if (
    line.startsWith("diff --git") ||
    line.startsWith("---") ||
    line.startsWith("+++") ||
    line.startsWith("index ")
  ) {
    className += " font-bold text-foreground";
  } else {
    className += " text-muted-foreground";
  }
  return <div className={className}>{line || " "}</div>;
}

function FileSection({
  file,
  reviewMode,
  selected,
  onToggle,
}: {
  file: DiffFile;
  reviewMode?: boolean;
  selected?: boolean;
  onToggle?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const filename = extractFilename(file.header);

  return (
    <div
      className={`mb-4 overflow-hidden rounded-md border border-border ${
        reviewMode && !selected ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-center bg-muted/50 hover:bg-muted">
        {reviewMode && (
          <label className="flex items-center pl-3" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              className="h-3.5 w-3.5 cursor-pointer rounded border-muted-foreground accent-green-500"
            />
          </label>
        )}
        <button
          className="flex flex-1 items-center gap-2 px-3 py-2 text-left text-xs font-medium"
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="text-muted-foreground">
            {collapsed ? "+" : "-"}
          </span>
          <span className="font-mono">{filename}</span>
        </button>
      </div>
      {!collapsed && (
        <div className="overflow-x-auto">
          {file.header.split("\n").slice(1).map((line, i) => (
            <DiffLine key={`h-${i}`} line={line} />
          ))}
          {file.hunks.map((hunk, i) =>
            hunk.split("\n").map((line, j) => (
              <DiffLine key={`${i}-${j}`} line={line} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function GitDiffViewer({
  taskId,
  open,
  onOpenChange,
  reviewMode,
  onApproveWithSelection,
}: GitDiffViewerProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["diff", taskId],
    queryFn: async () => {
      const res = await fetch(`/api/tasks/${taskId}/diff`);
      if (!res.ok) throw new Error("Failed to fetch diff");
      return res.json() as Promise<{ diff: string; error?: string }>;
    },
    enabled: open,
  });

  const files = useMemo(() => {
    if (!data?.diff) return [];
    return parseDiffFiles(data.diff);
  }, [data?.diff]);

  // Track which files are selected (included). All selected by default.
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  // Reset selection when files change
  useMemo(() => {
    setSelectedFiles(new Set(files.map((f) => extractFilename(f.header))));
  }, [files]);

  const toggleFile = useCallback((filename: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }
      return next;
    });
  }, []);

  const handleCopy = () => {
    if (data?.diff) {
      navigator.clipboard.writeText(data.diff);
      toast.success("Diff copied to clipboard");
    }
  };

  const handleApprove = () => {
    if (!onApproveWithSelection) return;
    const allFilenames = files.map((f) => extractFilename(f.header));
    const excluded = allFilenames.filter((f) => !selectedFiles.has(f));
    onApproveWithSelection(excluded);
  };

  const allSelected = files.length > 0 && selectedFiles.size === files.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Git Diff</span>
            <div className="flex items-center gap-2">
              {reviewMode && onApproveWithSelection && files.length > 0 && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleApprove}
                  className="bg-green-600 hover:bg-green-700"
                  disabled={selectedFiles.size === 0}
                >
                  {allSelected
                    ? "Approve All"
                    : `Approve Selected (${selectedFiles.size}/${files.length})`}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                disabled={!data?.diff}
              >
                Copy
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          {isLoading && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              Loading diff...
            </div>
          )}

          {error && (
            <div className="py-8 text-center text-sm text-red-400">
              {error instanceof Error ? error.message : "Failed to load diff"}
            </div>
          )}

          {data?.error && (
            <div className="py-4 text-center text-sm text-yellow-400">
              {data.error}
            </div>
          )}

          {!isLoading && !error && files.length === 0 && !data?.error && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No diff available
            </div>
          )}

          {files.map((file, i) => {
            const filename = extractFilename(file.header);
            return (
              <FileSection
                key={i}
                file={file}
                reviewMode={reviewMode}
                selected={selectedFiles.has(filename)}
                onToggle={() => toggleFile(filename)}
              />
            );
          })}

          {/* Show raw diff if parsing produced no files but diff text exists */}
          {data?.diff && files.length === 0 && !data.error && (
            <div className="overflow-x-auto">
              {data.diff.split("\n").map((line, i) => (
                <DiffLine key={i} line={line} />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
