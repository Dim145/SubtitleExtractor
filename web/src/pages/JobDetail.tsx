import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, APIError } from "../api/client";
import type { Job, JobResult, LogEntry } from "../api/types";
import { Card, ProgressBar, Spinner, StatusBadge } from "../components/ui";
import { formatBytes, formatRelative, subtitleFilename } from "../lib/format";
import { sameOriginApiUrl } from "../lib/url";

const ACTIVE = new Set(["queued", "claimed", "running"]);

export function JobDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [results, setResults] = useState<JobResult[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const cursor = useRef(0);
  const logBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    let es: EventSource | null = null;
    let pollTimer: number | undefined;

    // Load the full job once (filename etc.); live updates arrive via SSE.
    api
      .getJob(id)
      .then((j) => {
        if (stop) return;
        setJob(j);
        if (!ACTIVE.has(j.status)) api.jobResults(id).then((r) => !stop && setResults(r)).catch(() => {});
      })
      .catch(() => !stop && setNotFound(true));

    // Polling fallback if SSE is unavailable.
    function startPolling() {
      if (pollTimer) return;
      async function tick() {
        try {
          const j = await api.getJob(id);
          if (stop) return;
          setJob(j);
          const newLogs = await api.jobLogs(id, cursor.current);
          if (newLogs.length) {
            cursor.current = newLogs[newLogs.length - 1].id;
            setLogs((prev) => [...prev, ...newLogs]);
          }
          if (!ACTIVE.has(j.status)) {
            setResults(await api.jobResults(id));
            if (pollTimer) clearInterval(pollTimer);
          }
        } catch {
          /* transient */
        }
      }
      tick();
      pollTimer = window.setInterval(tick, 2500);
    }

    try {
      es = new EventSource(`/api/jobs/${id}/events`);
      es.addEventListener("progress", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setJob((prev) => (prev ? { ...prev, progressPct: d.pct, progressStage: d.stage } : prev));
      });
      es.addEventListener("log", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setLogs((prev) => [...prev, { id: prev.length + 1, jobId: id, ts: d.ts, level: d.level, message: d.message }]);
      });
      es.addEventListener("status", (e) => {
        const d = JSON.parse((e as MessageEvent).data);
        setJob((prev) => (prev ? { ...prev, status: d.status } : prev));
        api.jobResults(id).then((r) => !stop && setResults(r)).catch(() => {});
      });
      es.addEventListener("done", () => es?.close());
      es.onerror = () => {
        // SSE dropped → fall back to polling.
        es?.close();
        es = null;
        if (!stop) startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      stop = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [id]);

  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [logs]);

  if (notFound) return <Card>Job not found.</Card>;
  if (!job)
    return (
      <Card>
        <Spinner /> <span style={{ marginLeft: 8 }}>Loading…</span>
      </Card>
    );

  const active = ACTIVE.has(job.status);

  async function cancelJob() {
    setBusy(true);
    try {
      await api.cancelJob(id);
    } catch (e) {
      if (!(e instanceof APIError && e.status === 409)) alert("Failed to cancel");
    } finally {
      setBusy(false);
    }
  }

  async function deleteJob() {
    if (!window.confirm("Delete this job and its files? This can't be undone.")) return;
    setBusy(true);
    try {
      await api.deleteJob(id);
      navigate("/");
    } catch {
      alert("Failed to delete");
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <Link to="/" style={{ fontSize: 13, color: "var(--text-muted)" }}>
        ← All jobs
      </Link>

      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <h1 style={{ fontSize: 18, flex: 1, minWidth: 0, wordBreak: "break-all" }}>
            {job.sourceFilename}
          </h1>
          <StatusBadge status={job.status} />
          {active && (
            <button className="btn" onClick={cancelJob} disabled={busy}>
              Cancel
            </button>
          )}
          <button
            className="btn btn-ghost"
            style={{ color: "var(--err)" }}
            onClick={deleteJob}
            disabled={busy}
          >
            Delete
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          <ProgressBar pct={job.progressPct} />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 8,
              fontSize: 12,
              color: "var(--text-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            <span>
              {job.progressPct}% {job.progressStage ? `· ${job.progressStage}` : ""}
            </span>
            <span>created {formatRelative(job.createdAt)}</span>
          </div>
        </div>

        {job.status === "failed" && job.errorMessage && (
          <div
            style={{
              marginTop: 14,
              padding: "10px 12px",
              borderRadius: 8,
              background: "rgba(229,83,75,0.1)",
              border: "1px solid rgba(229,83,75,0.3)",
              color: "var(--err)",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
            }}
          >
            {job.errorMessage}
          </div>
        )}
      </Card>

      {results.length > 0 && (
        <Card>
          <h2 style={{ fontSize: 15, marginBottom: 12 }}>Subtitles</h2>
          <div style={{ display: "grid", gap: 8 }}>
            {results.map((r) => (
              <div
                key={r.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 12px",
                  background: "var(--bg-2)",
                  borderRadius: 8,
                }}
              >
                <span
                  className="mono"
                  style={{
                    textTransform: "uppercase",
                    color: "var(--accent-2)",
                    fontWeight: 700,
                    fontSize: 12,
                    width: 44,
                  }}
                >
                  {r.kind}
                </span>
                <span style={{ flex: 1, fontSize: 13, color: "var(--text-muted)" }}>
                  {r.language ? `${r.language} · ` : ""}
                  {formatBytes(r.byteSize)}
                </span>
                {(r.kind === "ass" || r.kind === "srt" || r.kind === "vtt") && (
                  <Link className="btn btn-ghost" to={`/jobs/${job.id}/editor`}>
                    Edit
                  </Link>
                )}
                {(() => {
                  const name = subtitleFilename(job.sourceFilename, r.kind);
                  const base = sameOriginApiUrl(r.downloadUrl);
                  const href = base + (base.includes("?") ? "&" : "?") + "name=" + encodeURIComponent(name);
                  return (
                    <a className="btn" href={href} download={name}>
                      Download
                    </a>
                  );
                })()}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 18px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h2 style={{ fontSize: 14 }}>Logs</h2>
          {active && <Spinner size={12} />}
        </div>
        <div
          ref={logBox}
          style={{
            maxHeight: 320,
            overflowY: "auto",
            padding: "12px 18px",
            fontFamily: "var(--font-mono)",
            fontSize: 12.5,
            lineHeight: 1.7,
          }}
        >
          {logs.length === 0 ? (
            <span style={{ color: "var(--text-faint)" }}>No logs yet…</span>
          ) : (
            logs.map((l) => (
              <div key={l.id} style={{ display: "flex", gap: 12 }}>
                <span style={{ color: "var(--text-faint)" }}>
                  {new Date(l.ts).toLocaleTimeString()}
                </span>
                <span
                  style={{
                    color:
                      l.level === "error"
                        ? "var(--err)"
                        : l.level === "warn"
                          ? "var(--warn)"
                          : "var(--text)",
                  }}
                >
                  {l.message}
                </span>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
