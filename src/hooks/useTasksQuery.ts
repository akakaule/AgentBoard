"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Task, Board, Integration, Memory, Skill } from "@/generated/prisma/client";

async function fetchTasks(boardId: string): Promise<Task[]> {
  const res = await fetch(`/api/tasks?boardId=${encodeURIComponent(boardId)}`);
  if (!res.ok) throw new Error("Failed to fetch tasks");
  return res.json();
}

export function useTasksQuery(boardId: string = "default") {
  return useQuery({
    queryKey: ["tasks", boardId],
    queryFn: () => fetchTasks(boardId),
  });
}

// Board hooks
export function useBoardsQuery() {
  return useQuery({
    queryKey: ["boards"],
    queryFn: async (): Promise<Board[]> => {
      const res = await fetch("/api/boards");
      if (!res.ok) throw new Error("Failed to fetch boards");
      return res.json();
    },
  });
}

export function useCreateBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      repoPath?: string;
      baseBranch?: string;
      gitProvider?: string;
    }) => {
      const res = await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to create board");
      }
      return res.json() as Promise<Board>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["boards"] });
    },
  });
}

export function useUpdateBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...data
    }: {
      id: string;
      name?: string;
      description?: string;
      repoPath?: string;
      baseBranch?: string;
      gitProvider?: string;
    }) => {
      const res = await fetch(`/api/boards/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update board");
      }
      return res.json() as Promise<Board>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["boards"] });
    },
  });
}

export function useDeleteBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/boards/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete board");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["boards"] });
    },
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      title: string;
      description?: string;
      criteria?: string;
      repoUrl?: string;
      priority?: number;
      tags?: string;
      dependsOn?: string;
      model?: string;
      boardId?: string;
      scheduledFor?: string;
      cronExpression?: string;
      recurring?: boolean;
    }) => {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create task");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...data
    }: {
      id: string;
      status?: string;
      position?: number;
      title?: string;
      description?: string;
      criteria?: string;
      repoUrl?: string;
      priority?: number;
      tags?: string;
      dependsOn?: string;
      model?: string;
      error?: string | null;
      scheduledFor?: string | null;
      cronExpression?: string;
      recurring?: boolean;
      excludedFiles?: string[];
    }) => {
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to update task");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete task");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useClearDoneTasks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/tasks?scope=done", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to clear done tasks");
      return res.json() as Promise<{ success: boolean; deletedCount: number }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useStopTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/tasks/${id}/stop`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to stop task");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useRetryTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/tasks/${id}/retry`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to retry task");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useDispatcherStatus() {
  return useQuery({
    queryKey: ["dispatcher"],
    queryFn: async () => {
      const res = await fetch("/api/dispatcher");
      if (!res.ok) throw new Error("Failed to fetch dispatcher status");
      return res.json() as Promise<{
        running: boolean;
        activeTasks: number;
        maxConcurrent: number;
      }>;
    },
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json() as Promise<{ maxConcurrent: number; editorCommand: string }>;
    },
  });
}

export function useUpdateSetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { key: string; value: string }) => {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update setting");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      queryClient.invalidateQueries({ queryKey: ["dispatcher"] });
    },
  });
}

// Integration hooks
export function useIntegrationsQuery() {
  return useQuery({
    queryKey: ["integrations"],
    queryFn: async (): Promise<Integration[]> => {
      const res = await fetch("/api/integrations");
      if (!res.ok) throw new Error("Failed to fetch integrations");
      return res.json();
    },
  });
}

export function useCreateIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      type: string;
      name: string;
      config: string;
      enabled?: boolean;
      events?: string;
      boardId?: string;
    }) => {
      const res = await fetch("/api/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create integration");
      return res.json() as Promise<Integration>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

export function useUpdateIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...data
    }: {
      id: string;
      name?: string;
      config?: string;
      enabled?: boolean;
      events?: string;
      boardId?: string;
    }) => {
      const res = await fetch(`/api/integrations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update integration");
      return res.json() as Promise<Integration>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

export function useDeleteIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/integrations/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete integration");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
}

export function useTestIntegration() {
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/integrations/${id}/test`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Test notification failed");
      }
      return res.json() as Promise<{ success: boolean }>;
    },
  });
}

// Memory hooks
export function useMemoryQuery(boardId: string) {
  return useQuery({
    queryKey: ["memory", boardId],
    queryFn: async (): Promise<Memory[]> => {
      const res = await fetch(`/api/memory?boardId=${encodeURIComponent(boardId)}`);
      if (!res.ok) throw new Error("Failed to fetch memories");
      return res.json();
    },
  });
}

export function useCreateMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      boardId: string;
      key: string;
      value: string;
      source?: string;
      sourceTaskId?: string;
    }) => {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create memory");
      return res.json() as Promise<Memory>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
  });
}

export function useUpdateMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, value }: { id: string; value: string }) => {
      const res = await fetch(`/api/memory/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error("Failed to update memory");
      return res.json() as Promise<Memory>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
  });
}

export function useDeleteMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/memory/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete memory");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memory"] });
    },
  });
}

// Skill hooks
export function useSkillsQuery() {
  return useQuery({
    queryKey: ["skills"],
    queryFn: async (): Promise<Skill[]> => {
      const res = await fetch("/api/skills");
      if (!res.ok) throw new Error("Failed to fetch skills");
      return res.json();
    },
  });
}

export function useCreateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      name: string;
      description?: string;
      prompt?: string;
      criteria?: string;
      model?: string;
      tags?: string;
    }) => {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create skill");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

export function useUpdateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...data }: {
      id: string;
      name?: string;
      description?: string;
      prompt?: string;
      criteria?: string;
      model?: string;
      tags?: string;
    }) => {
      const res = await fetch(`/api/skills/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update skill");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/skills/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete skill");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
}

// Analytics hooks
interface AnalyticsData {
  dailyCosts: { date: string; cost: number; tokens: number }[];
  modelBreakdown: { model: string; cost: number; tokens: number; count: number }[];
  summary: {
    totalCost: number;
    totalTasks: number;
    avgCost: number;
    totalInputTokens: number;
    totalOutputTokens: number;
  };
  topTasks: { id: string; title: string; cost: number; model: string; tokens: number }[];
}

export function useAnalyticsQuery(boardId: string, period: string) {
  return useQuery({
    queryKey: ["analytics", boardId, period],
    queryFn: async (): Promise<AnalyticsData> => {
      const res = await fetch(
        `/api/analytics?boardId=${encodeURIComponent(boardId)}&period=${encodeURIComponent(period)}`
      );
      if (!res.ok) throw new Error("Failed to fetch analytics");
      return res.json();
    },
  });
}
