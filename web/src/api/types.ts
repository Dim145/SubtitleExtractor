export interface User {
  id: string;
  email: string;
  displayName: string;
  provider: "local" | "oidc";
  isAdmin: boolean;
  createdAt: string;
}

export interface AuthConfig {
  localEnabled: boolean;
  localRegistrationEnabled: boolean;
  oidcEnabled: boolean;
}

export type JobStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface JobParams {
  language?: string;
  ocr_backend?: string;
  crop?: string;
  fps?: number;
  formats?: string[];
}

export interface Job {
  id: string;
  userId: string;
  status: JobStatus;
  workerClass: string;
  sourceFilename: string;
  params: JobParams;
  progressPct: number;
  progressStage: string | null;
  claimedBy: string | null;
  attempt: number;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobResult {
  id: string;
  jobId: string;
  kind: string;
  language: string | null;
  byteSize: number | null;
  createdAt: string;
  downloadUrl: string;
}

export interface LogEntry {
  id: number;
  jobId: string;
  ts: string;
  level: string;
  message: string;
}

// Normalized subtitle zone (0..1 relative to the intrinsic video frame).
export interface Zone {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A post-OCR find→replace rule applied by workers to cue text after merging.
export interface OCRSubstitutionRule {
  find: string;
  replace: string;
  isRegex: boolean;
  applyTo: string; // "all" or a language code (e.g. "fr")
}

export interface SiteSettings {
  registrationEnabled: boolean;
  defaultOcrBackend: string;
  defaultFps: number;
  defaultMinConfidence: number;
  workerDefaults: Record<string, unknown>;
  ocrSubstitutionRules: OCRSubstitutionRule[];
}

// A typed field descriptor a worker advertises so the admin can render a form.
export interface ConfigField {
  key: string;
  label: string;
  type: "select" | "number" | "boolean" | "text";
  default?: unknown;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  help?: string;
}

export interface Worker {
  id: string;
  name: string;
  workerClass: string;
  enabled: boolean;
  status: "online" | "busy" | "offline";
  lastHeartbeat: string | null;
  currentJobId: string | null;
  currentJobLabel: string | null;
  capabilities: Record<string, unknown>;
  config: Record<string, unknown>;
  configVersion: number;
  createdAt: string;
}
