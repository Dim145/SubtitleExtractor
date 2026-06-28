import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { api, APIError } from "../api/client";
import type { Job } from "../api/types";
import { Card, EmptyState, ProgressBar, StatusBadge } from "../components/ui";
import { ZoneSelector, type SubmitOpts } from "../editor/ZoneSelector";
import { formatRelative } from "../lib/format";

const ACTIVE = new Set(["queued", "claimed", "running"]);

interface Availability {
  total: number;
  online: number;
  busy: number;
  idle: number;
  available: boolean;
}

export function Dashboard() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [avail, setAvail] = useState<Availability | null>(null);

  async function refresh() {
    try {
      const [j, a] = await Promise.all([api.listJobs(), api.workerAvailability()]);
      setJobs(j);
      setAvail(a);
    } catch {
      /* keep last known */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ display: "grid", gap: 24 }}>
      {avail && !avail.available && <WorkerWarning avail={avail} />}
      <UploadPanel onCreated={refresh} />

      <section>
        <h2 style={{ fontSize: 16, marginBottom: 14 }}>Extraction jobs</h2>
        {loading ? (
          <Card>
            <p style={{ color: "var(--text-muted)", margin: 0 }}>Loading…</p>
          </Card>
        ) : jobs.length === 0 ? (
          <Card>
            <EmptyState
              title="No jobs yet"
              hint="Upload a video above to extract its hardcoded subtitles."
            />
          </Card>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} onDeleted={refresh} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function WorkerWarning({ avail }: { avail: Availability }) {
  const reason =
    avail.total === 0
      ? "No extraction workers are registered."
      : avail.online === 0
        ? "No worker is online right now."
        : "All workers are busy right now.";
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        padding: "14px 18px",
        borderRadius: 10,
        background: "rgba(245,181,68,0.10)",
        border: "1px solid rgba(245,181,68,0.35)",
        color: "var(--text)",
      }}
    >
      <span style={{ color: "var(--warn)", fontSize: 18, lineHeight: "20px" }} aria-hidden>
        ⚠
      </span>
      <div style={{ fontSize: 13, lineHeight: 1.5 }}>
        <strong style={{ color: "var(--warn)" }}>{reason}</strong> Your job will wait in the
        queue until one is free. To skip the wait, you can extract subtitles{" "}
        <strong>directly in your browser</strong> — pick a video below and choose{" "}
        <span className="mono">“Extract in browser”</span> (no upload, runs locally; best on a
        WebGPU browser).
      </div>
    </div>
  );
}

function JobRow({ job, onDeleted }: { job: Job; onDeleted: () => void }) {
  async function del(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm("Delete this job and its files?")) return;
    try {
      await api.deleteJob(job.id);
    } catch {
      /* ignore */
    }
    onDeleted();
  }
  return (
    <Link
      to={`/jobs/${job.id}`}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 140px 90px 36px",
        alignItems: "center",
        gap: 16,
        padding: "14px 18px",
        background: "var(--bg-1)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        textDecoration: "none",
        color: "var(--text)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontWeight: 500,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {job.sourceFilename}
        </div>
        <div style={{ marginTop: 8 }}>
          <ProgressBar pct={job.progressPct} />
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginTop: 6,
            fontFamily: "var(--font-mono)",
          }}
        >
          {ACTIVE.has(job.status)
            ? `${job.progressPct}% · ${job.progressStage ?? "queued"}`
            : formatRelative(job.createdAt)}
        </div>
      </div>
      <StatusBadge status={job.status} />
      <span style={{ fontSize: 12, color: "var(--text-faint)", textAlign: "right" }}>
        {formatRelative(job.createdAt)}
      </span>
      <button
        onClick={del}
        title="Delete job"
        aria-label="Delete job"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--text-faint)",
          cursor: "pointer",
          fontSize: 16,
          padding: 6,
        }}
      >
        ✕
      </button>
    </Link>
  );
}

function UploadPanel({ onCreated }: { onCreated: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function process(opts: SubmitOpts) {
    if (!file) return;
    setError(null);
    setBusy(true);
    const form = new FormData();
    form.append("file", file);
    if (opts.language) form.append("language", opts.language);
    form.append("formats", opts.formats.join(","));
    if (opts.zones.length > 0) form.append("zones", JSON.stringify(opts.zones));
    try {
      await api.createJob(form);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      onCreated();
    } catch (err) {
      setError(err instanceof APIError ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 style={{ fontSize: 16, marginBottom: 6 }}>New extraction</h2>
      <p style={{ color: "var(--text-muted)", fontSize: 13, margin: "0 0 14px" }}>
        Pick a video, mark where the subtitles are, and extract. The least-busy
        worker picks it up automatically.
      </p>
      <input
        ref={fileRef}
        type="file"
        accept="video/*,.mkv,.mp4"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      {error && (
        <p role="alert" style={{ color: "var(--err)", fontSize: 13, marginTop: 12 }}>
          {error}
        </p>
      )}

      {file && (
        <ZoneSelector
          file={file}
          busy={busy}
          onCancel={() => {
            setFile(null);
            if (fileRef.current) fileRef.current.value = "";
          }}
          onSubmit={process}
        />
      )}
    </Card>
  );
}
