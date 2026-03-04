"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  DragDropContext,
  type DropResult,
} from "@hello-pangea/dnd";
import { Column } from "./Column";
import { BoardSelector } from "./BoardSelector";
import { CreateTaskForm } from "../forms/CreateTaskForm";
import { DispatcherToggle } from "./DispatcherToggle";
import { NotificationToggle } from "./NotificationToggle";
import { BoardStats } from "./BoardStats";
import { SearchBar } from "./SearchBar";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { IntegrationsPanel } from "./IntegrationsPanel";
import { MemoryPanel } from "./MemoryPanel";
import { ChatPlannerPanel } from "./ChatPlannerPanel";
import { SkillsLibrary } from "../skills/SkillsLibrary";
import { AnalyticsPanel } from "../analytics/AnalyticsPanel";
import { Button } from "@/components/ui/button";
import {
  useTasksQuery,
  useUpdateTask,
  useClearDoneTasks,
  useDispatcherStatus,
} from "@/hooks/useTasksQuery";
import { useEventSource } from "@/hooks/useEventSource";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { COLUMN_ORDER, TaskStatus } from "@/lib/types";
import type { Task, Skill } from "@/generated/prisma/client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

export function Board() {
  useEventSource();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [boardId, setBoardId] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("agentboard-boardId") || "default";
    }
    return "default";
  });

  const handleBoardChange = useCallback((id: string) => {
    setBoardId(id);
    localStorage.setItem("agentboard-boardId", id);
  }, []);

  const { data: tasks = [], isLoading } = useTasksQuery(boardId);
  const updateTask = useUpdateTask();
  const clearDoneTasks = useClearDoneTasks();
  const { data: dispatcherStatus } = useDispatcherStatus();

  // Search & filter state
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");

  // Task form + shortcuts help + integrations + memory + skills dialogs
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [chatPlannerOpen, setChatPlannerOpen] = useState(false);
  const [importingIssues, setImportingIssues] = useState(false);

  const handleUseSkill = useCallback((skill: Skill) => {
    setSelectedSkill(skill);
    setCreateFormOpen(true);
  }, []);

  // Extract unique tags from all tasks
  const availableTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const task of tasks) {
      if (task.tags) {
        for (const tag of task.tags.split(",")) {
          const trimmed = tag.trim();
          if (trimmed) tagSet.add(trimmed);
        }
      }
    }
    return Array.from(tagSet).sort();
  }, [tasks]);

  // Filter tasks
  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      // Search filter
      if (search) {
        const q = search.toLowerCase();
        const matchesTitle = task.title.toLowerCase().includes(q);
        const matchesDesc = task.description.toLowerCase().includes(q);
        if (!matchesTitle && !matchesDesc) return false;
      }
      // Priority filter
      if (priorityFilter !== "all" && task.priority !== parseInt(priorityFilter)) {
        return false;
      }
      // Tag filter
      if (tagFilter !== "all") {
        const taskTags = task.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        if (!taskTags.includes(tagFilter)) return false;
      }
      return true;
    });
  }, [tasks, search, priorityFilter, tagFilter]);

  const tasksByStatus = useMemo(() => {
    const grouped: Record<string, Task[]> = {
      todo: [],
      ready: [],
      in_progress: [],
      review: [],
      done: [],
    };
    for (const task of filteredTasks) {
      const status = task.status === "failed" ? "done" : task.status;
      if (grouped[status]) {
        grouped[status].push(task);
      }
    }
    // Newest first in each column
    for (const key of Object.keys(grouped)) {
      grouped[key].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return grouped;
  }, [filteredTasks]);
  const doneCount = tasksByStatus.done.length;

  const onDragEnd = useCallback(
    (result: DropResult) => {
      if (!result.destination) return;

      const { draggableId, destination } = result;
      const newStatus = destination.droppableId;

      // Prevent manual drag into "in_progress" or "review" - only dispatcher does this
      if (newStatus === TaskStatus.IN_PROGRESS || newStatus === TaskStatus.REVIEW) return;

      const task = tasks.find((t) => t.id === draggableId);
      if (!task) return;

      // Don't update if status hasn't changed
      if (task.status === newStatus) return;

      // Don't allow dragging failed/in_progress tasks directly
      if (
        task.status === TaskStatus.IN_PROGRESS ||
        task.status === TaskStatus.FAILED
      )
        return;

      updateTask.mutate({
        id: draggableId,
        status: newStatus,
        position: destination.index,
      });
    },
    [tasks, updateTask]
  );

  const handleExport = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/export?boardId=${boardId}`);
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `agentboard-tasks-${boardId}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Tasks exported");
    } catch {
      toast.error("Failed to export tasks");
    }
  }, [boardId]);

  const handleImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const res = await fetch("/api/tasks/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Import failed");
        }
        const result = await res.json();
        toast.success(`Imported ${result.imported} tasks`);
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to import tasks");
      }
      // Reset file input so same file can be re-imported
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [queryClient]
  );

  const handleImportIssues = useCallback(async () => {
    setImportingIssues(true);
    try {
      const res = await fetch("/api/issues/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boardId, limit: 50 }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Issue import failed");
      }
      const result = await res.json();
      toast.success(`Imported ${result.imported} issues (${result.provider})`);
      queryClient.invalidateQueries({ queryKey: ["tasks", boardId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import issues");
    } finally {
      setImportingIssues(false);
    }
  }, [boardId, queryClient]);

  // Keyboard shortcuts
  const handleToggleDispatcher = useCallback(async () => {
    try {
      const res = await fetch("/api/dispatcher", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: dispatcherStatus?.running ? "stop" : "start",
        }),
      });
      if (!res.ok) throw new Error("Failed to toggle dispatcher");
    } catch {
      // silently ignore
    }
  }, [dispatcherStatus?.running]);

  const shortcutHandlers = useMemo(
    () => ({
      onNewTask: () => setCreateFormOpen(true),
      onToggleDispatcher: handleToggleDispatcher,
      onShowHelp: () => setShortcutsHelpOpen(true),
    }),
    [handleToggleDispatcher]
  );
  useKeyboardShortcuts(shortcutHandlers);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-muted-foreground">Loading board...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">AgentBoard</h1>
          <BoardSelector boardId={boardId} onBoardChange={handleBoardChange} />
        </div>
        <div className="flex items-center gap-3">
          <NotificationToggle />
          <Button variant="outline" size="sm" onClick={handleExport}>
            Export
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            Import
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleImportIssues}
            disabled={importingIssues}
          >
            {importingIssues ? "Importing..." : "Import Issues"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImport}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => clearDoneTasks.mutate()}
            disabled={clearDoneTasks.isPending || doneCount === 0}
          >
            Clear Done
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setChatPlannerOpen(true)}
          >
            Chat Planner
          </Button>
          <Button
            variant={analyticsOpen ? "default" : "outline"}
            size="sm"
            onClick={() => setAnalyticsOpen(!analyticsOpen)}
          >
            Analytics
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSkillsOpen(true)}
          >
            Skills
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMemoryOpen(true)}
          >
            Memory
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIntegrationsOpen(true)}
          >
            Integrations
          </Button>
          <DispatcherToggle />
          <CreateTaskForm
            boardId={boardId}
            externalOpen={createFormOpen}
            onExternalOpenChange={(open) => {
              setCreateFormOpen(open);
              if (!open) setSelectedSkill(null);
            }}
            initialSkill={selectedSkill}
          />
        </div>
      </header>

      <BoardStats />

      <SearchBar
        search={search}
        onSearchChange={setSearch}
        priorityFilter={priorityFilter}
        onPriorityFilterChange={setPriorityFilter}
        tagFilter={tagFilter}
        onTagFilterChange={setTagFilter}
        availableTags={availableTags}
      />

      <ShortcutsHelp open={shortcutsHelpOpen} onOpenChange={setShortcutsHelpOpen} />
      <IntegrationsPanel open={integrationsOpen} onOpenChange={setIntegrationsOpen} />
      <MemoryPanel boardId={boardId} open={memoryOpen} onOpenChange={setMemoryOpen} />
      <SkillsLibrary open={skillsOpen} onOpenChange={setSkillsOpen} onUseSkill={handleUseSkill} />
      <ChatPlannerPanel boardId={boardId} open={chatPlannerOpen} onOpenChange={setChatPlannerOpen} />

      {analyticsOpen && <AnalyticsPanel boardId={boardId} />}

      <div className="flex flex-1 gap-6 overflow-x-auto p-6">
        <DragDropContext onDragEnd={onDragEnd}>
          {COLUMN_ORDER.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={tasksByStatus[status] || []}
            />
          ))}
        </DragDropContext>
      </div>
    </div>
  );
}
