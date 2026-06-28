import type { JobStatus } from "@/api/types";
import { cn } from "@/lib/cn";

const MAP: Record<JobStatus, { label: string; cls: string; dot: string; pulse?: boolean }> = {
  queued: { label: "queued", cls: "text-muted", dot: "bg-muted" },
  claimed: { label: "claimed", cls: "text-info", dot: "bg-info" },
  running: { label: "running", cls: "text-accent border-accent/40", dot: "bg-accent", pulse: true },
  succeeded: { label: "succeeded", cls: "text-ok", dot: "bg-ok" },
  failed: { label: "failed", cls: "text-err", dot: "bg-err" },
  canceled: { label: "canceled", cls: "text-faint", dot: "bg-faint" },
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const s = MAP[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide", s.cls)}>
      <span className={cn("size-1.5 rounded-full", s.dot, s.pulse && "animate-pulse")} />
      {s.label}
    </span>
  );
}

export function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-gradient-to-r from-accent to-amber transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}
