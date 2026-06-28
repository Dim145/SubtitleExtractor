import type {
  AuthConfig,
  Job,
  JobResult,
  LogEntry,
  SiteSettings,
  User,
  Worker,
} from "./types";

// Same-origin in dev via the Vite proxy; configurable for other deployments.
const BASE = import.meta.env.VITE_API_URL ?? "";

export class APIError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new APIError(res.status, msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function json(body: unknown): RequestInit {
  return jsonReq("POST", body);
}

function jsonReq(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const api = {
  authConfig: () => request<AuthConfig>("/api/auth/config"),
  me: () => request<User>("/api/auth/me"),
  login: (email: string, password: string) =>
    request<User>("/api/auth/login", json({ email, password })),
  register: (email: string, password: string, displayName: string) =>
    request<User>("/api/auth/register", json({ email, password, displayName })),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  oidcLoginUrl: () => `${BASE}/api/auth/oidc/login`,

  workerAvailability: () =>
    request<{ total: number; online: number; busy: number; idle: number; available: boolean }>(
      "/api/workers/availability",
    ),

  listJobs: () => request<Job[]>("/api/jobs"),
  getJob: (id: string) => request<Job>(`/api/jobs/${id}`),
  cancelJob: (id: string) => request<void>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  deleteJob: (id: string) => request<void>(`/api/jobs/${id}`, { method: "DELETE" }),
  jobLogs: (id: string, after = 0) =>
    request<LogEntry[]>(`/api/jobs/${id}/logs?after=${after}`),
  jobResults: (id: string) => request<JobResult[]>(`/api/jobs/${id}/results`),
  jobVideo: (id: string) =>
    request<{ url: string; filename: string }>(`/api/jobs/${id}/video`),

  createJob: (form: FormData) =>
    request<Job>("/api/jobs", { method: "POST", body: form }),

  saveResult: (id: string, content: string, kind: string, language?: string) => {
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/plain" }), `subtitles.${kind}`);
    form.append("kind", kind);
    if (language) form.append("language", language);
    return request<JobResult>(`/api/jobs/${id}/results`, { method: "POST", body: form });
  },

  admin: {
    users: () => request<User[]>("/api/admin/users"),
    createUser: (u: { email: string; password: string; displayName?: string; isAdmin?: boolean }) =>
      request<User>("/api/admin/users", jsonReq("POST", u)),
    setUserAdmin: (id: string, isAdmin: boolean) =>
      request<void>(`/api/admin/users/${id}`, jsonReq("PATCH", { isAdmin })),
    deleteUser: (id: string) =>
      request<void>(`/api/admin/users/${id}`, { method: "DELETE" }),

    settings: () => request<SiteSettings>("/api/admin/settings"),
    saveSettings: (s: SiteSettings) =>
      request<SiteSettings>("/api/admin/settings", jsonReq("PUT", s)),

    workers: () => request<Worker[]>("/api/admin/workers"),
    patchWorker: (id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }) =>
      request<void>(`/api/admin/workers/${id}`, jsonReq("PATCH", patch)),
    deleteWorker: (id: string) =>
      request<void>(`/api/admin/workers/${id}`, { method: "DELETE" }),
  },
};
