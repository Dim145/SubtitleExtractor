import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Job } from "./types";

const ACTIVE: Job["status"][] = ["queued", "claimed", "running"];

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: api.jobs,
    // Poll while any job is in flight so progress/status stay live.
    refetchInterval: (q) => (q.state.data?.some((j) => ACTIVE.includes(j.status)) ? 2500 : false),
  });
}

export function useJob(id: string) {
  return useQuery({
    queryKey: ["job", id],
    queryFn: () => api.job(id),
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.status) ? 2000 : false),
  });
}

export function useJobResults(id: string) {
  return useQuery({ queryKey: ["job-results", id], queryFn: () => api.jobResults(id) });
}

export function useWorkerAvailability() {
  return useQuery({
    queryKey: ["worker-availability"],
    queryFn: api.workerAvailability,
    refetchInterval: 15_000,
  });
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => api.createJob(form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useDeleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });
}

export function useDeleteResult(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (resultId: string) => api.deleteResult(jobId, resultId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["job-results", jobId] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
  });
}
