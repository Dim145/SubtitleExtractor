import { lazy, Suspense, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
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

  return (
    <div className="mx-auto max-w-5xl px-5 py-8">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-faint">Workspace</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Jobs</h1>
        </div>
        <Button variant="primary" onClick={() => fileRef.current?.click()}>
          <Plus className="size-4" /> New extraction
        </Button>
      </div>

      {showWarn && (
        <div className="mb-4 flex items-center gap-3 rounded-xl border px-4 py-3 text-sm"
             style={{ borderColor: "color-mix(in srgb, var(--warn) 35%, var(--border))", background: "color-mix(in srgb, var(--warn) 12%, var(--surface))" }}>
          <TriangleAlert className="size-[18px] shrink-0 text-warn" />
          <span>No worker is available right now. You can still <b>extract in your browser</b> from the editor.</span>
        </div>
      )}

      <label
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); setPickerFile(e.dataTransfer.files?.[0] ?? null); }}
        className={cn(
          "mb-6 grid cursor-pointer place-items-center rounded-xl border border-dashed border-border-strong bg-surface px-6 py-9 text-center transition-colors",
          drag && "border-accent bg-accent/5",
        )}
      >
        <input ref={fileRef} type="file" accept="video/*,.mkv,.mp4" className="hidden"
               onChange={(e) => { setPickerFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
        <span className="mb-3 grid size-11 place-items-center rounded-xl bg-surface-2 text-accent"><UploadCloud className="size-5" /></span>
        <div className="font-medium">Drop a video, or click to browse</div>
        <div className="mt-1 text-sm text-muted">MP4 / MKV · outputs SRT, ASS &amp; VTT</div>
      </label>

      {jobs.isLoading ? (
        <div className="grid place-items-center py-16"><Spinner className="size-6" /></div>
      ) : jobs.data && jobs.data.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-border">
          {jobs.data.map((j, i) => <JobRow key={j.id} job={j} divider={i > 0} />)}
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-surface px-6 py-16 text-center">
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

function JobRow({ job, divider }: { job: Job; divider: boolean }) {
  const cancel = useCancelJob();
  const del = useDeleteJob();
  const active = ACTIVE.includes(job.status);

  return (
    <div className={cn("flex items-center gap-3 bg-surface px-4 py-3 transition-colors hover:bg-surface-2", divider && "border-t border-border")}>
      <span className="grid h-7 w-11 shrink-0 place-items-center rounded border border-border bg-surface-3 text-faint"><Film className="size-3.5" /></span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{job.sourceFilename}</div>
        <div className="mt-0.5 font-mono text-xs text-faint">
          {job.workerClass} · {formatRelative(job.createdAt)}
          {job.progressStage && active ? ` · ${job.progressStage}` : ""}
        </div>
      </div>
      {active && <div className="hidden w-40 sm:block"><ProgressBar pct={job.progressPct} /></div>}
      <StatusBadge status={job.status} />
      <div className="flex items-center gap-1">
        {job.status === "succeeded" && (
          <Link to="/jobs/$id/editor" params={{ id: job.id }} title="Edit">
            <Button variant="ghost" size="icon"><Pencil className="size-4" /></Button>
          </Link>
        )}
        {active && (
          <Button variant="ghost" size="icon" title="Cancel" onClick={() => cancel.mutate(job.id)}><X className="size-4" /></Button>
        )}
        <Link to="/jobs/$id" params={{ id: job.id }} title="Open">
          <Button variant="ghost" size="icon"><ChevronRight className="size-4" /></Button>
        </Link>
        {!active && (
          <Button variant="ghost" size="icon" title="Delete" className="hover:text-err"
                  onClick={() => del.mutate(job.id)}><Trash2 className="size-4" /></Button>
        )}
      </div>
    </div>
  );
}
