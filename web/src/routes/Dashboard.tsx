import { lazy, Suspense, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { UploadCloud, Plus, TriangleAlert, ChevronRight, Trash2, X, Pencil, Film } from "lucide-react";
import { useJobs, useWorkerAvailability, useCancelJob, useDeleteJob } from "@/api/jobs";
import type { Job } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge, ProgressBar } from "@/components/StatusBadge";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/cn";

// Lazy: pulls react-rnd (+ the decoder/OCR on demand) only when opening the modal.
const ZonePicker = lazy(() => import("@/editor/ZonePicker").then((m) => ({ default: m.ZonePicker })));

const ACTIVE: Job["status"][] = ["queued", "claimed", "running"];

export function Dashboard() {
  const jobs = useJobs();
  const avail = useWorkerAvailability();
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [pickerFile, setPickerFile] = useState<File | null>(null);

  const showWarn = avail.data && !avail.data.available;
  const count = jobs.data?.length ?? 0;

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <div className="animate-in mb-5 flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-faint">Workspace</div>
          <h1 className="mt-1 flex items-baseline gap-2 text-2xl font-semibold tracking-tight">
            Jobs {count > 0 && <span className="text-base font-normal text-faint tabular-nums">{count}</span>}
          </h1>
        </div>
        <Button variant="primary" onClick={() => fileRef.current?.click()}>
          <Plus className="size-4" /> New extraction
        </Button>
      </div>

      {showWarn && (
        <div className="animate-in mb-4 flex items-center gap-3 rounded-xl border px-4 py-3 text-sm"
             style={{ borderColor: "color-mix(in srgb, var(--warn) 35%, var(--border))", background: "color-mix(in srgb, var(--warn) 12%, var(--surface))" }}>
          <TriangleAlert className="size-[18px] shrink-0 text-warn" />
          <span>No worker is available right now. You can still <b>extract in your browser</b> from the editor.</span>
        </div>
      )}

      <label
        role="button" tabIndex={0} aria-label="Upload a video — drop a file or press Enter to browse"
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); setPickerFile(e.dataTransfer.files?.[0] ?? null); }}
        className={cn(
          "animate-in group mb-6 grid cursor-pointer place-items-center rounded-xl border border-dashed border-border-strong bg-surface px-6 py-9 text-center transition-colors hover:border-accent/50 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
          drag && "border-accent bg-accent/5",
        )}
      >
        <input ref={fileRef} type="file" accept="video/*,.mkv,.mp4" className="hidden"
               onChange={(e) => { setPickerFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <span className={cn("mb-3 grid size-11 place-items-center rounded-xl bg-surface-2 text-accent transition-transform group-hover:scale-105", drag && "scale-110")}><UploadCloud className="size-5" /></span>
        <div className="font-medium">Drop a video, or click to browse</div>
        <div className="mt-1 text-sm text-muted">MP4 / MKV · outputs SRT, ASS &amp; VTT</div>
      </label>

      {jobs.isLoading ? (
        <div className="overflow-hidden rounded-xl border border-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className={cn("flex items-center gap-3 px-4 py-3.5", i > 0 && "border-t border-border")}>
              <div className="size-7 w-11 shrink-0 animate-pulse rounded bg-surface-2" />
              <div className="flex-1 space-y-2">
                <div className="h-3.5 w-2/3 animate-pulse rounded bg-surface-2" />
                <div className="h-2.5 w-1/3 animate-pulse rounded bg-surface-2" />
              </div>
              <div className="h-5 w-20 animate-pulse rounded-full bg-surface-2" />
            </div>
          ))}
        </div>
      ) : jobs.data && jobs.data.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-border">
          {jobs.data.map((j, i) => <JobRow key={j.id} job={j} index={i} />)}
        </div>
      ) : (
        <div className="animate-in rounded-xl border border-border bg-surface px-6 py-16 text-center">
          <Film className="mx-auto mb-3 size-7 text-faint" />
          <div className="font-medium">No jobs yet</div>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">Upload a video to extract its hardcoded subtitles.</p>
        </div>
      )}

      {pickerFile && (
        <Suspense fallback={null}>
          <ZonePicker file={pickerFile} onClose={() => setPickerFile(null)} />
        </Suspense>
      )}
    </div>
  );
}

function JobRow({ job, index }: { job: Job; index: number }) {
  const navigate = useNavigate();
  const cancel = useCancelJob();
  const del = useDeleteJob();
  const active = ACTIVE.includes(job.status);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      onClick={() => navigate({ to: "/jobs/$id", params: { id: job.id } })}
      style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}
      className={cn(
        "animate-in group flex cursor-pointer items-center gap-3 bg-surface px-4 py-3 transition-colors hover:bg-surface-2",
        index > 0 && "border-t border-border",
        "relative before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent before:opacity-0 before:transition-opacity hover:before:opacity-100",
      )}
    >
      <span className="grid h-7 w-11 shrink-0 place-items-center rounded border border-border bg-surface-3 text-faint transition-colors group-hover:text-accent"><Film className="size-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{job.sourceFilename}</div>
        <div className="mt-0.5 font-mono text-xs text-faint">
          {job.workerClass} · {formatRelative(job.createdAt)}
          {job.progressStage && active ? ` · ${job.progressStage}` : ""}
        </div>
      </div>
      {active && <div className="hidden w-40 sm:block"><ProgressBar pct={job.progressPct} /></div>}
      <StatusBadge status={job.status} />
      <div className="flex items-center gap-1" onClick={stop}>
        {job.status === "succeeded" && (
          <Link to="/jobs/$id/editor" params={{ id: job.id }} title="Edit" aria-label="Edit subtitles">
            <Button variant="ghost" size="icon" aria-label="Edit subtitles"><Pencil className="size-4" /></Button>
          </Link>
        )}
        {active && (
          <Button
            variant="ghost" size="icon" aria-label="Cancel job"
            title={cancel.isError ? "Cancel failed — try again" : "Cancel"}
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(job.id)}
          >{cancel.isPending ? <Spinner /> : <X className="size-4" />}</Button>
        )}
        {!active && (
          <Button
            variant="ghost" size="icon" aria-label="Delete job" className="hover:text-err"
            title={del.isError ? "Delete failed — try again" : "Delete"}
            disabled={del.isPending}
            onClick={() => del.mutate(job.id)}
          >{del.isPending ? <Spinner /> : <Trash2 className="size-4" />}</Button>
        )}
        <ChevronRight aria-hidden="true" className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-muted" />
      </div>
    </div>
  );
}
