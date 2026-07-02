import type {
  AdminUser, AuthConfig, CleanupRun, Job, JobResult, LogEntry, SiteSettings, User, Worker,
} from "./types";

export class APIError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "APIError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  const body: unknown = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : typeof body === "string" && body
          ? body
          : res.statusText;
    throw new APIError(res.status, msg || "Request failed");
  }
  return body as T;
}

function jsonReq(method: string, data: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) };
}

export interface WorkerAvailability {
  total: number;
  online: number;
  busy: number;
  idle: number;
  available: boolean;
}

export const api = {
  // ---- auth ----
  authConfig: () => request<AuthConfig>("/api/auth/config"),
  me: () => request<User>("/api/auth/me"),
  login: (email: string, password: string) =>
    request<User>("/api/auth/login", jsonReq("POST", { email, password })),
  register: (d: { email: string; password: string; displayName?: string }) =>
    request<User>("/api/auth/register", jsonReq("POST", d)),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  updateProfile: (d: { displayName?: string; email?: string; password?: string; currentPassword?: string }) =>
    request<User>("/api/auth/me", jsonReq("PATCH", d)),
  oidcLoginUrl: "/api/auth/oidc/login",

  // ---- jobs ----
  workerAvailability: () => request<WorkerAvailability>("/api/workers/availability"),
  jobs: () => request<Job[]>("/api/jobs"),
  job: (id: string) => request<Job>(`/api/jobs/${id}`),
  jobLogs: (id: string) => request<LogEntry[]>(`/api/jobs/${id}/logs`),
  jobResults: (id: string) => request<JobResult[]>(`/api/jobs/${id}/results`),
  // Returns a (presigned) URL to the source video — NOT the bytes. Caller must
  // use `.url` as the media source (see sameOriginApiUrl for local storage).
  jobVideo: (id: string) => request<{ url: string; filename: string }>(`/api/jobs/${id}/video`),
  cancelJob: (id: string) => request<void>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  rerunJob: (id: string) => request<Job>(`/api/jobs/${id}/rerun`, { method: "POST" }),
  deleteJob: (id: string) => request<void>(`/api/jobs/${id}`, { method: "DELETE" }),
  deleteVideo: (id: string) => request<void>(`/api/jobs/${id}/video`, { method: "DELETE" }),
  createJob: (form: FormData) => request<Job>("/api/jobs", { method: "POST", body: form }),
  saveResult: (id: string, content: string, kind: string, opts: { name?: string; language?: string; resultId?: string } = {}) => {
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/plain" }), opts.name || `subtitles.${kind}`);
    form.append("kind", kind);
    if (opts.name) form.append("name", opts.name);
    if (opts.language) form.append("language", opts.language);
    if (opts.resultId) form.append("resultId", opts.resultId);
    return request<JobResult>(`/api/jobs/${id}/results`, { method: "POST", body: form });
  },
  deleteResult: (jobId: string, resultId: string) =>
    request<{ jobDeleted: boolean }>(`/api/jobs/${jobId}/results/${resultId}`, { method: "DELETE" }),
  jobEventsUrl: (id: string) => `/api/jobs/${id}/events`,

  // ---- admin ----
  admin: {
    users: () => request<AdminUser[]>("/api/admin/users"),
    createUser: (u: { email: string; password: string; displayName?: string; isAdmin?: boolean }) =>
      request<User>("/api/admin/users", jsonReq("POST", u)),
    patchUser: (id: string, patch: { isAdmin?: boolean; storageQuotaBytes?: number | null }) =>
      request<void>(`/api/admin/users/${id}`, jsonReq("PATCH", patch)),
    deleteUser: (id: string) => request<void>(`/api/admin/users/${id}`, { method: "DELETE" }),

    settings: () => request<SiteSettings>("/api/admin/settings"),
    saveSettings: (s: SiteSettings) => request<SiteSettings>("/api/admin/settings", jsonReq("PUT", s)),
    videoCleanupRuns: () => request<CleanupRun[]>("/api/admin/video-cleanup/runs"),
    runVideoCleanup: () => request<CleanupRun>("/api/admin/video-cleanup/run", { method: "POST" }),

    workers: () => request<Worker[]>("/api/admin/workers"),
    patchWorker: (id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) =>
      request<void>(`/api/admin/workers/${id}`, jsonReq("PATCH", patch)),
    deleteWorker: (id: string) => request<void>(`/api/admin/workers/${id}`, { method: "DELETE" }),
  },
};
