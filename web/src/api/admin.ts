import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { SiteSettings } from "./types";

export function useUsers() {
  return useQuery({ queryKey: ["admin", "users"], queryFn: api.admin.users });
}
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.admin.createUser,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}
export function usePatchUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; isAdmin: boolean }) => api.admin.patchUser(v.id, { isAdmin: v.isAdmin }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.admin.deleteUser(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "users"] }),
  });
}

export function useAdminSettings() {
  return useQuery({ queryKey: ["admin", "settings"], queryFn: api.admin.settings });
}
export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: SiteSettings) => api.admin.saveSettings(s),
    onSuccess: (next) => qc.setQueryData(["admin", "settings"], next),
  });
}

export function useCleanupRuns() {
  return useQuery({ queryKey: ["admin", "cleanup-runs"], queryFn: api.admin.videoCleanupRuns });
}
export function useRunCleanup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.admin.runVideoCleanup(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "cleanup-runs"] }),
  });
}

export function useAdminWorkers() {
  return useQuery({ queryKey: ["admin", "workers"], queryFn: api.admin.workers, refetchInterval: 10_000 });
}
export function usePatchWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; enabled?: boolean; config?: Record<string, unknown> }) =>
      api.admin.patchWorker(v.id, { enabled: v.enabled, config: v.config }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "workers"] }),
  });
}
export function useDeleteWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.admin.deleteWorker(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "workers"] }),
  });
}
