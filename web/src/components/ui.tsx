import type { CSSProperties, ReactNode } from "react";
import type { JobStatus } from "../api/types";

const STATUS_COLOR: Record<JobStatus, string> = {
  queued: "var(--text-muted)",
  claimed: "var(--info)",
  running: "var(--accent-2)",
  succeeded: "var(--ok)",
  failed: "var(--err)",
  canceled: "var(--text-faint)",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const color = STATUS_COLOR[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        fontWeight: 500,
        color,
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: color,
          boxShadow: status === "running" ? `0 0 8px ${color}` : "none",
        }}
      />
      {status}
    </span>
  );
}

export function ProgressBar({ pct }: { pct: number }) {
  return (
    <div
      style={{
        height: 5,
        background: "var(--bg-3)",
        borderRadius: 999,
        overflow: "hidden",
      }}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          height: "100%",
          background: "var(--accent)",
          transition: "width 300ms var(--ease)",
        }}
      />
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        border: "2px solid var(--border-strong)",
        borderTopColor: "var(--accent)",
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
      }}
    />
  );
}

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "18px 20px",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "56px 24px",
        color: "var(--text-muted)",
      }}
    >
      {icon && <div style={{ fontSize: 28, marginBottom: 10 }}>{icon}</div>}
      <h3 style={{ color: "var(--text)", marginBottom: 6, fontSize: 16 }}>{title}</h3>
      {hint && <p style={{ margin: "0 auto 16px", maxWidth: 360 }}>{hint}</p>}
      {action}
    </div>
  );
}
