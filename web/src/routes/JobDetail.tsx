import { useEffect, useRef } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Download, Pencil } from "lucide-react";
import { useJob, useJobResults } from "@/api/jobs";
import { useJobEvents } from "@/api/useJobEvents";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge, ProgressBar } from "@/components/StatusBadge";
import { subtitleFilename, formatBytes } from "@/lib/format";
import { sameOriginApiUrl } from "@/lib/url";
import { cn } from "@/lib/cn";

const ACTIVE = ["queued", "claimed", "running"];

export function JobDetail() {
  const { id = "" } = useParams({ strict: false });
  const { data: job, isLoading } = useJob(id);
  const results = useJobResults(id);
  const logs = useJobEvents(id);

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [logs]);

  if (isLoading || !job) {
    return <div className="grid place-items-center py-24"><Spinner className="size-6" /></div>;
  }
  const active = ACTIVE.includes(job.status);

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <Link to="/" className="mb-4 inline-flex"><Button variant="ghost" size="sm"><ArrowLeft className="size-4" /> Jobs</Button></Link>

      <div className="mb-4 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-faint">
            {job.status}{job.progressStage ? ` · ${job.progressStage}` : ""}
          </div>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">{job.sourceFilename}</h1>
        </div>
        <StatusBadge status={job.status} />
      </div>

      {active && (
        <>
          <ProgressBar pct={job.progressPct} />
          <div className="mt-1.5 font-mono text-xs text-muted">{job.progressPct}% · {job.progressStage ?? "working"}</div>
        </>
      )}
      {job.status === "failed" && job.errorMessage && (
        <p className="rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-sm text-err">{job.errorMessage}</p>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <section className="rounded-xl border border-border bg-surface p-4">
          <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Live log</div>
          <div ref={logRef} className="max-h-72 overflow-auto rounded-lg border border-border bg-[#05070d] p-3 font-mono text-xs leading-relaxed">
            {logs.length === 0 ? (
              <span className="text-faint">No log output yet…</span>
            ) : (
              logs.map((l, i) => (
                <div key={i} className={cn(l.level === "error" && "text-err", l.level === "warn" && "text-warn")}>
                  <span className="text-faint">{new Date(l.ts).toLocaleTimeString()}</span> {l.message}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-surface p-4">
          <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Results</div>
          {results.data && results.data.length > 0 ? (
            <div className="grid gap-2">
              {results.data.map((r) => {
                const name = subtitleFilename(job.sourceFilename, r.kind);
                const base = sameOriginApiUrl(r.downloadUrl);
                const href = base + (base.includes("?") ? "&" : "?") + "name=" + encodeURIComponent(name);
                return (
                  <a key={r.id} href={href} download={name} className="flex items-center justify-between rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-sm hover:border-accent">
                    <span className="flex items-center gap-2"><Download className="size-4 text-muted" /> {name}</span>
                    <span className="font-mono text-xs text-faint">{r.kind.toUpperCase()} · {formatBytes(r.byteSize)}</span>
                  </a>
                );
              })}
              <Link to="/jobs/$id/editor" params={{ id }} className="mt-1">
                <Button variant="primary" className="w-full"><Pencil className="size-4" /> Open in editor</Button>
              </Link>
            </div>
          ) : (
            <p className="text-sm text-muted">{active ? "Results will appear when the job completes." : "No results."}</p>
          )}
        </section>
      </div>
    </div>
  );
}
