import { useEffect, useRef } from "react";
import { Link, useParams, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Download, Pencil, Trash2, RefreshCw, Film } from "lucide-react";
import { useJob, useJobResults, useDeleteResult, useRerunJob, useDeleteVideo } from "@/api/jobs";
import { useJobEvents } from "@/api/useJobEvents";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge, ProgressBar } from "@/components/StatusBadge";
import { subtitleFilename, formatBytes } from "@/lib/format";
import { downloadableUrl } from "@/lib/url";
import { cn } from "@/lib/cn";

const ACTIVE = ["queued", "claimed", "running"];

export function JobDetail() {
  const { id = "" } = useParams({ strict: false });
  const navigate = useNavigate();
  const { data: job, isLoading } = useJob(id);
  const results = useJobResults(id);
  const logs = useJobEvents(id);
  const delResult = useDeleteResult(id);
  const rerun = useRerunJob(id);
  const delVideo = useDeleteVideo(id);

  function doRerun() {
    rerun.mutate(undefined, {
      onError: (e: unknown) => window.alert(e instanceof Error ? e.message : "Re-run failed"),
    });
  }
  function removeVideo() {
    if (!window.confirm("Delete the source video? Your subtitles are kept, but you won't be able to re-run or preview this job's video.")) return;
    delVideo.mutate(undefined, {
      onError: (e: unknown) => window.alert(e instanceof Error ? e.message : "Failed to delete video"),
    });
  }

  function removeResult(resultId: string, name: string, isLast: boolean) {
    const msg = isLast
      ? `Delete "${name}"? It's the last subtitle file — this deletes the whole job and its video.`
      : `Delete "${name}"?`;
    if (!window.confirm(msg)) return;
    delResult.mutate(resultId, { onSuccess: (r) => { if (r.jobDeleted) navigate({ to: "/" }); } });
  }

  // Download via the presigned URL; if that's unreachable (non-public bucket,
  // S3 signature/clock-skew), fall back to streaming through the API.
  async function downloadResult(r: { id: string; downloadUrl: string }, filename: string) {
    const res = await fetch(downloadableUrl(r.downloadUrl, `/api/jobs/${id}/results/${r.id}/download`), { credentials: "include" });
    const blob = await res.blob();
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u; a.download = filename; a.click();
    URL.revokeObjectURL(u);
  }

  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [logs]);

  if (isLoading || !job) {
    return <div className="grid place-items-center py-24"><Spinner className="size-6" /></div>;
  }
  const active = ACTIVE.includes(job.status);

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <Link to="/" className="mb-4 inline-flex"><Button variant="ghost" size="sm"><ArrowLeft className="size-4" /> Jobs</Button></Link>

      <div className="animate-in mb-4 flex items-end justify-between gap-4">
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

      {!active && (
        <div className="animate-in mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-4" style={{ animationDelay: "30ms" }}>
          {job.videoDeletedAt ? (
            <div className="flex items-center gap-2.5 text-sm text-muted">
              <Film className="size-4 shrink-0 text-faint" />
              <span>Source video removed <span className="text-faint">· subtitles kept · re-run unavailable</span></span>
            </div>
          ) : (
            <div className="flex items-center gap-2.5 text-sm">
              <Film className="size-4 shrink-0 text-accent" />
              <span>Source video available <span className="text-faint">· re-run extraction or free up storage</span></span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" disabled={!!job.videoDeletedAt || rerun.isPending} onClick={doRerun}
              title={job.videoDeletedAt ? "The source video has been deleted" : "Queue a fresh extraction (your subtitles are kept)"}>
              {rerun.isPending ? <Spinner /> : <RefreshCw className="size-4" />} Re-run
            </Button>
            {!job.videoDeletedAt && (
              <Button variant="danger" size="sm" disabled={delVideo.isPending} onClick={removeVideo}>
                {delVideo.isPending ? <Spinner /> : <Trash2 className="size-4" />} Delete video
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-[1.4fr_1fr]">
        <section className="animate-in rounded-xl border border-border bg-surface p-4" style={{ animationDelay: "60ms" }}>
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

        <section className="animate-in rounded-xl border border-border bg-surface p-4" style={{ animationDelay: "120ms" }}>
          <div className="mb-2.5 text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Results</div>
          {results.data && results.data.length > 0 ? (
            <div className="grid gap-2">
              {results.data.map((r) => {
                const name = r.name || subtitleFilename(job.sourceFilename, r.kind);
                const isLast = results.data!.length === 1;
                return (
                  <div key={r.id} className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface-2 pr-1 hover:border-accent">
                    <button type="button" onClick={() => downloadResult(r, name)} className="flex min-w-0 flex-1 items-center justify-between gap-2 px-3 py-2 text-left text-sm">
                      <span className="flex min-w-0 items-center gap-2"><Download className="size-4 shrink-0 text-muted" /> <span className="truncate">{name}</span></span>
                      <span className="shrink-0 font-mono text-xs text-faint">{r.kind.toUpperCase()} · {formatBytes(r.byteSize)}</span>
                    </button>
                    <button
                      type="button" aria-label={isLast ? "Delete file (removes the whole job)" : "Delete file"}
                      title={isLast ? "Delete (removes the whole job)" : "Delete file"}
                      disabled={delResult.isPending}
                      onClick={() => removeResult(r.id, name, isLast)}
                      className="grid size-9 shrink-0 place-items-center rounded-md text-faint transition hover:bg-err/15 hover:text-err disabled:opacity-50 sm:size-7"
                    >{delResult.isPending ? <Spinner /> : <Trash2 className="size-4" />}</button>
                  </div>
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
