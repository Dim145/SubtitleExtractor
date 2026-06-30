import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2, Save, Download, Check, X, ChevronDown, ArrowUpToLine, ArrowDownToLine, TriangleAlert } from "lucide-react";
import { useJob } from "@/api/jobs";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useWaveform } from "@/editor/useWaveform";
import { useSourcePlayer } from "@/editor/player/useSourcePlayer";
import { usePlayerHotkeys } from "@/editor/player/usePlayerHotkeys";
import { MediaStage } from "@/editor/player/MediaStage";
import {
  type Cue, parseSubtitles, displayTime, parseDisplayTime, newCue, toASS, toSRT, toVTT,
} from "@/editor/subtitles";
import { downloadableUrl } from "@/lib/url";
import { subtitleFilename } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useDialog } from "@/components/ui/useDialog";

type Format = "ass" | "srt" | "vtt";

// OCR mean line score below this is worth a manual review.
const LOW_CONFIDENCE = 0.7;
const isLowConfidence = (c: Cue) => c.confidence !== undefined && c.confidence < LOW_CONFIDENCE;

/** Strip a trailing extension from a filename. */
function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, "");
}

/** Map an ASS \an (1-9 numpad) to overlay positioning. */
function anClasses(an: number): string {
  const v = an >= 7 ? "items-start" : an >= 4 ? "items-center" : "items-end";
  const h = an % 3 === 1 ? "justify-start text-left" : an % 3 === 2 ? "justify-center text-center" : "justify-end text-right";
  return `${v} ${h}`;
}

export function Editor() {
  const { id = "" } = useParams({ strict: false });
  const { data: job } = useJob(id);
  const qc = useQueryClient();

  // The result this editor loaded (so "overwrite" targets the right file).
  const [sourceResultId, setSourceResultId] = useState<string | null>(null);
  const [sourceResultName, setSourceResultName] = useState<string>("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveMode, setSaveMode] = useState<"overwrite" | "new">("new");

  const [cues, setCues] = useState<Cue[]>([]);
  const [dims, setDims] = useState({ width: 1280, height: 720 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [format, setFormat] = useState<Format>("ass");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);
  const [videoUnavailable, setVideoUnavailable] = useState(false);
  // Pending in-point for mark-in/out cue creation (I = mark in, O = mark out).
  const [markIn, setMarkIn] = useState<number | null>(null);
  const markInRef = useRef<number | null>(null);
  markInRef.current = markIn;
  const [addMenu, setAddMenu] = useState(false);

  const [waveEl, setWaveEl] = useState<HTMLDivElement | null>(null);
  const cueListRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);

  // One unified player (native <video>, or WebCodecs frames for MKV/HEVC).
  const player = useSourcePlayer({ url: mediaUrl });
  usePlayerHotkeys(player);
  const currentTime = player.currentTime;

  // currentTime in a ref so editing hotkeys don't rebind on every frame.
  const timeRef = useRef(0);
  timeRef.current = currentTime;

  // ---- load existing subtitles ----
  useEffect(() => {
    let stop = false;
    setLoading(true);
    (async () => {
      try {
        const results = await api.jobResults(id);
        const pick = results.find((r) => r.kind === "ass") ?? results.find((r) => r.kind === "srt") ?? results.find((r) => r.kind === "vtt");
        if (!pick) { if (!stop) { setError("This job has no subtitles to edit yet."); setLoading(false); } return; }
        const text = await fetch(downloadableUrl(pick.downloadUrl, `/api/jobs/${id}/results/${pick.id}/download`), { credentials: "include" }).then((r) => r.text());
        const parsed = parseSubtitles(text, pick.kind);
        if (stop) return;
        setSourceResultId(pick.id);
        setSourceResultName(pick.name ?? "");
        setFormat((pick.kind as Format) ?? "ass");
        setCues(parsed.cues);
        if (parsed.width && parsed.height) setDims({ width: parsed.width, height: parsed.height });
        setSelectedId(parsed.cues[0]?.id ?? null);
        setLoading(false);
      } catch {
        if (!stop) { setError("Failed to load subtitles."); setLoading(false); }
      }
    })();
    return () => { stop = true; };
  }, [id]);

  // ---- resolve the source video URL (the /video endpoint returns JSON {url}) ----
  useEffect(() => {
    let stop = false;
    setMediaUrl(null);
    setVideoUnavailable(false);
    (async () => {
      try {
        const info = await api.jobVideo(id);
        if (!stop) setMediaUrl(downloadableUrl(info.url, `/api/jobs/${id}/video/raw`));
      } catch {
        if (!stop) setVideoUnavailable(true); // no source → editing still works
      }
    })();
    return () => { stop = true; };
  }, [id]);

  // Prefer the real video resolution for ASS export once the player knows it.
  useEffect(() => {
    if ((player.mode === "video" || player.mode === "canvas") && player.dims.width) setDims(player.dims);
  }, [player.mode, player.dims]);

  const wave = useWaveform({
    media: player.mediaEl, container: waveEl, cues, selectedId,
    onUpdate: (cid, start, end) => { setCues((prev) => prev.map((c) => (c.id === cid ? { ...c, start, end } : c))); setDirty(true); },
    onSelect: (cid) => { setSelectedId(cid); const c = cues.find((x) => x.id === cid); if (c) player.seek(c.start); },
    onCreate: (start, end) => addCueRange(start, end),
  });

  // active cue (under the playhead) — drives the caption overlay + auto-scroll.
  const activeId = useMemo(() => cues.find((c) => currentTime >= c.start && currentTime < c.end)?.id ?? null, [cues, currentTime]);
  useEffect(() => {
    const el = cueListRef.current?.querySelector(`[data-cue="${activeId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  const activeCue = cues.find((c) => c.id === activeId);

  // Cues OCR flagged as low-confidence — surfaced as a "N to review" chip.
  const lowConfCount = useMemo(() => cues.filter(isLowConfidence).length, [cues]);
  /** Select and scroll to the first low-confidence cue. */
  function reviewFirstLowConf() {
    const c = [...cues].sort((a, b) => a.start - b.start).find(isLowConfidence);
    if (!c) return;
    setSelectedId(c.id); player.seek(c.start);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    cueListRef.current?.querySelector(`[data-cue="${c.id}"]`)?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }

  function patch(cid: string, p: Partial<Cue>) { setCues((prev) => prev.map((c) => (c.id === cid ? { ...c, ...p } : c))); setDirty(true); }

  /** Focus (and scroll to) a cue's text field once its row has rendered. */
  function focusCue(id: string) {
    requestAnimationFrame(() => {
      const el = cueListRef.current?.querySelector<HTMLTextAreaElement>(`[data-cue="${id}"] textarea`);
      el?.focus();
      el?.scrollIntoView({ block: "nearest" });
    });
  }
  /** Create a cue spanning [start, end], select it, and focus its text. */
  function addCueRange(start: number, end: number) {
    const s = Math.max(0, start);
    const e = Math.max(end, s + 0.3); // keep cues at least readable-length
    const c = newCue(s, e);
    setCues((prev) => [...prev, c].sort((a, b) => a.start - b.start));
    setSelectedId(c.id); setDirty(true); focusCue(c.id);
  }
  /** Add at the playhead, clamped so it doesn't overrun the next cue. */
  function addCueAtPlayhead() {
    const t = timeRef.current;
    const next = cues.filter((c) => c.start > t).sort((a, b) => a.start - b.start)[0];
    addCueRange(t, next ? Math.min(t + 2, next.start) : t + 2);
  }
  /** Insert into the gap after `beforeEnd` (afterStart = next cue's start, null at the end). */
  function insertBetween(beforeEnd: number, afterStart: number | null) {
    addCueRange(beforeEnd, afterStart != null ? Math.min(beforeEnd + 2, afterStart) : beforeEnd + 2);
  }
  /** Insert above/below the selected cue (falls back to the playhead). */
  function insertRelative(dir: "above" | "below") {
    setAddMenu(false);
    const sorted = [...cues].sort((a, b) => a.start - b.start);
    const idx = sorted.findIndex((c) => c.id === selectedId);
    if (idx < 0) return addCueAtPlayhead();
    const sel = sorted[idx];
    if (dir === "below") { insertBetween(sel.end, sorted[idx + 1]?.start ?? null); return; }
    const prev = sorted[idx - 1];
    let start = prev ? Math.max(prev.end, sel.start - 2) : Math.max(0, sel.start - 2);
    if (start >= sel.start) start = Math.max(0, sel.start - 0.5);
    addCueRange(start, sel.start);
  }
  function delCue(cid: string) { setCues((prev) => prev.filter((c) => c.id !== cid)); setDirty(true); }

  function serialize(): string {
    return format === "ass" ? toASS(cues, dims.width, dims.height) : format === "vtt" ? toVTT(cues) : toSRT(cues);
  }
  function openSave() {
    const base = stripExt(sourceResultName) || stripExt(job?.sourceFilename ?? "") || "subtitles";
    setSaveName(base);
    setSaveMode(sourceResultId ? "overwrite" : "new");
    setSaveOpen(true);
  }
  async function doSave() {
    setSaving(true);
    try {
      const name = `${saveName.trim() || "subtitles"}.${format}`;
      const res = await api.saveResult(id, serialize(), format, {
        name,
        resultId: saveMode === "overwrite" ? sourceResultId ?? undefined : undefined,
      });
      setSourceResultId(res.id);
      setSourceResultName(res.name ?? name);
      setDirty(false);
      setSaveOpen(false);
      qc.invalidateQueries({ queryKey: ["job-results", id] });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    } finally { setSaving(false); }
  }
  function exportFile() {
    const blob = new Blob([serialize()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = subtitleFilename(job?.sourceFilename, format); a.click();
    URL.revokeObjectURL(url);
  }

  // Editing keys ([ / ] set in/out at the playhead · ↑/↓ move selection).
  // Transport keys (Space, ← →, Home) live in usePlayerHotkeys, shared site-wide.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName) || t.isContentEditable) return;
      if (e.key === "[" && selectedId) { e.preventDefault(); patch(selectedId, { start: timeRef.current }); return; }
      if (e.key === "]" && selectedId) { e.preventDefault(); patch(selectedId, { end: timeRef.current }); return; }
      if (e.key === "n" || e.key === "N") { e.preventDefault(); addCueAtPlayhead(); return; }
      if (e.key === "i" || e.key === "I") { e.preventDefault(); setMarkIn(timeRef.current); return; }
      if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        const inPt = markInRef.current;
        if (inPt != null && timeRef.current > inPt) { addCueRange(inPt, timeRef.current); setMarkIn(null); }
        return;
      }
      if (e.key === "Escape" && markInRef.current != null) { setMarkIn(null); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!cues.length) return;
        e.preventDefault();
        const idx = cues.findIndex((c) => c.id === selectedId);
        const ni = Math.max(0, Math.min(cues.length - 1, (idx < 0 ? 0 : idx) + (e.key === "ArrowDown" ? 1 : -1)));
        const c = cues[ni];
        if (c) { setSelectedId(c.id); player.seek(c.start); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedId, cues, player.seek]);

  // Close the add-menu when clicking outside it.
  useEffect(() => {
    if (!addMenu) return;
    const onDoc = (e: MouseEvent) => { if (!addRef.current?.contains(e.target as Node)) setAddMenu(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [addMenu]);

  const caption = activeCue ? (
    <div className={cn("pointer-events-none absolute inset-0 flex p-6", anClasses(activeCue.an))}>
      <span className="whitespace-pre-wrap rounded bg-black/65 px-3 py-1 text-[clamp(13px,2.4vw,20px)] font-medium text-white shadow">{activeCue.text}</span>
    </div>
  ) : null;

  return (
    // key={id} force-remounts the editor body on job→job navigation so the
    // player + waveform fully reset (no stale decoder / wavesurfer instance).
    <div key={id} className="mx-auto max-w-[1180px] px-5 py-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/jobs/$id" params={{ id }}><Button variant="ghost" size="sm"><ArrowLeft className="size-4" /> Job</Button></Link>
          <h1 className="truncate text-lg font-semibold tracking-tight">{job?.sourceFilename ?? "Editor"}</h1>
        </div>
        <div className="flex items-center gap-2 text-xs">
          {dirty ? <span className="text-amber">● Unsaved</span> : <span className="flex items-center gap-1 text-ok"><Check className="size-3.5" /> Saved</span>}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
          <div ref={addRef} className="relative flex">
            <Button variant="default" size="sm" onClick={addCueAtPlayhead} className="rounded-r-none" title="Add a cue at the playhead (N)">
              <Plus className="size-3.5" /> Cue
            </Button>
            <Button
              variant="default" size="sm" aria-label="More ways to add a cue" aria-haspopup="menu" aria-expanded={addMenu}
              onClick={() => setAddMenu((o) => !o)} className="rounded-l-none border-l-0 px-1.5"
            ><ChevronDown className={cn("size-3.5 transition-transform", addMenu && "rotate-180")} /></Button>
            {addMenu && (
              <div role="menu" className="absolute left-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-lg border border-border-strong bg-surface py-1 shadow-xl">
                <button role="menuitem" type="button" onClick={() => { setAddMenu(false); addCueAtPlayhead(); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-2">
                  <Plus className="size-3.5 text-accent" /> Add at playhead <kbd className="ml-auto font-mono text-[10px] text-faint">N</kbd>
                </button>
                <button role="menuitem" type="button" disabled={!selectedId} onClick={() => insertRelative("above")}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent">
                  <ArrowUpToLine className="size-3.5 text-accent" /> Insert above selected
                </button>
                <button role="menuitem" type="button" disabled={!selectedId} onClick={() => insertRelative("below")}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent">
                  <ArrowDownToLine className="size-3.5 text-accent" /> Insert below selected
                </button>
              </div>
            )}
          </div>
          <Button variant="default" size="sm" disabled={!selectedId} onClick={() => selectedId && delCue(selectedId)}><Trash2 className="size-3.5" /> Delete</Button>
          {markIn != null && (
            <span className="flex items-center gap-1.5 rounded-lg border border-amber/40 bg-amber/10 px-2 py-1 text-xs text-amber">
              <span className="size-1.5 rounded-full bg-amber" /> in {displayTime(markIn).slice(3)} · press <kbd className="font-mono">O</kbd>
              <button type="button" aria-label="Clear mark-in" onClick={() => setMarkIn(null)} className="ml-0.5 grid size-4 place-items-center rounded hover:bg-amber/20"><X className="size-3" /></button>
            </span>
          )}
          <span className="mx-1 h-5 w-px bg-border" />
          <select value={format} onChange={(e) => setFormat(e.target.value as Format)} className="h-8 rounded-lg border border-border-strong bg-surface px-2 text-[13px]">
            <option value="ass">ASS</option><option value="srt">SRT</option><option value="vtt">VTT</option>
          </select>
          {lowConfCount > 0 && (
            <button
              type="button" onClick={reviewFirstLowConf}
              aria-label={`${lowConfCount} low-confidence ${lowConfCount === 1 ? "cue" : "cues"} to review — jump to the first`}
              className="flex h-8 items-center gap-1.5 rounded-lg border border-amber/40 bg-amber/10 px-2 text-xs text-amber transition hover:bg-amber/20"
            >
              <TriangleAlert className="size-3.5" /> {lowConfCount} to review
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="default" size="sm" onClick={exportFile}><Download className="size-3.5" /> Export</Button>
            <Button variant="primary" size="sm" onClick={openSave} disabled={saving || loading || !!error}>
              <Save className="size-3.5" /> Save…
            </Button>
          </div>
        </div>

        <div className="grid lg:grid-cols-[1.55fr_1fr]">
          {/* stage: player + waveform */}
          <div className="border-border lg:border-r">
            {videoUnavailable ? (
              <div className="relative aspect-video bg-black">
                <div className="absolute inset-0 grid place-items-center bg-surface-2 px-6 text-center">
                  <div>
                    <div className="text-sm font-medium">Source video unavailable</div>
                    <p className="mx-auto mt-1 max-w-xs text-xs text-muted">The original video can’t be previewed (removed, or an unsupported format). Cue text and timing editing still work.</p>
                  </div>
                </div>
              </div>
            ) : (
              <MediaStage player={player} overlay={caption} />
            )}
            <div className="p-3">
              {player.mode === "video" ? (
                <>
                  <div ref={setWaveEl} className="rounded-lg border border-border bg-surface-2 p-1" />
                  <div className="mt-2 flex items-center gap-2 text-xs text-faint">
                    <input type="range" min={20} max={220} defaultValue={60} onChange={(e) => wave.zoom(Number(e.target.value))} className="w-32" />
                    <span className="font-mono">zoom</span>
                  </div>
                </>
              ) : player.mode === "canvas" ? (
                <div className="text-xs text-muted">Frame preview · audio waveform unavailable for this container</div>
              ) : null}
            </div>
          </div>

          {/* cue table */}
          <div className="flex max-h-[560px] flex-col">
            <div className="grid grid-cols-[28px_88px_1fr_40px] gap-2 border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint sm:grid-cols-[28px_88px_1fr_32px]">
              <span>#</span><span>Time</span><span>Text</span><span />
            </div>
            <div ref={cueListRef} className="overflow-auto">
              {loading ? (
                <div className="grid place-items-center py-16"><Spinner className="size-5" /></div>
              ) : error ? (
                <p className="px-3 py-10 text-center text-sm text-muted">{error}</p>
              ) : cues.length === 0 ? (
                <div className="grid place-items-center px-6 py-16 text-center">
                  <div className="grid size-12 place-items-center rounded-2xl border border-accent/30 bg-accent/10 text-accent"><Plus className="size-6" /></div>
                  <div className="mt-3 text-sm font-medium">Add your first subtitle</div>
                  <p className="mx-auto mt-1 max-w-[16rem] text-xs text-muted">
                    {player.mode === "video"
                      ? <>Drag across the waveform to draw a cue, or press <kbd className="font-mono text-accent">N</kbd> to add one at the playhead.</>
                      : <>Press <kbd className="font-mono text-accent">N</kbd> to add a cue at the playhead, or use the button below.</>}
                  </p>
                  <Button variant="primary" size="sm" className="mt-3" onClick={addCueAtPlayhead}><Plus className="size-3.5" /> Add subtitle</Button>
                </div>
              ) : (
                <>
                  {cues.map((c, i) => (
                    <Fragment key={c.id}>
                      <div
                        data-cue={c.id}
                        onClick={() => { setSelectedId(c.id); player.seek(c.start); }}
                        className={cn(
                          "grid cursor-pointer grid-cols-[28px_88px_1fr_40px] gap-2 border-b border-border px-3 py-2 text-sm sm:grid-cols-[28px_88px_1fr_32px]",
                          c.id === activeId && "bg-amber/10",
                          // Faint amber left accent for OCR low-confidence cues (yields to the selected accent below).
                          isLowConfidence(c) && c.id !== selectedId && "bg-amber/[0.06] shadow-[inset_2px_0_0_var(--amber)]",
                          c.id === selectedId ? "bg-accent/10 shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-surface-2",
                        )}
                      >
                        <span className="flex items-start gap-1 pt-1 font-mono text-xs text-faint">
                          {i + 1}
                          {isLowConfidence(c) && (
                            <span
                              role="img"
                              aria-label={`Low OCR confidence (${Math.round(c.confidence! * 100)}%) — review recommended`}
                              title={`Low OCR confidence (${Math.round(c.confidence! * 100)}%) — review recommended`}
                            >
                              <TriangleAlert className="size-3.5 shrink-0 text-amber" aria-hidden />
                            </span>
                          )}
                        </span>
                        <div className="grid gap-1" onClick={(e) => e.stopPropagation()}>
                          <input
                            defaultValue={displayTime(c.start)} key={`s-${c.id}-${c.start}`}
                            inputMode="decimal" aria-label={`Cue ${i + 1} start time`}
                            onBlur={(e) => { const v = parseDisplayTime(e.target.value); if (v != null) patch(c.id, { start: v }); }}
                            className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-[16px] text-amber hover:border-border focus:border-accent focus:bg-surface-2 sm:text-[13px]"
                          />
                          <input
                            defaultValue={displayTime(c.end)} key={`e-${c.id}-${c.end}`}
                            inputMode="decimal" aria-label={`Cue ${i + 1} end time`}
                            onBlur={(e) => { const v = parseDisplayTime(e.target.value); if (v != null) patch(c.id, { end: v }); }}
                            className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-[16px] text-faint hover:border-border focus:border-accent focus:bg-surface-2 sm:text-[13px]"
                          />
                        </div>
                        <textarea
                          defaultValue={c.text} key={`t-${c.id}`} rows={2}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => patch(c.id, { text: e.target.value })}
                          className="resize-none rounded border border-transparent bg-transparent px-1.5 py-1 text-[13px] leading-snug hover:border-border focus:border-accent focus:bg-surface-2"
                        />
                        <button
                          type="button" title="Delete cue" aria-label={`Delete cue ${i + 1}`}
                          onClick={(e) => { e.stopPropagation(); delCue(c.id); }}
                          className="grid size-9 self-start place-items-center rounded text-faint transition hover:bg-err/15 hover:text-err sm:size-7"
                        ><X className="size-4" /></button>
                      </div>
                      {i < cues.length - 1 && (
                        <div className="group/ins relative h-1.5">
                          <button
                            type="button" aria-label={`Insert a cue between ${i + 1} and ${i + 2}`}
                            onClick={() => insertBetween(c.end, cues[i + 1].start)}
                            className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border border-accent/50 bg-surface px-2 py-0.5 text-[11px] text-accent opacity-0 transition focus-visible:opacity-100 group-hover/ins:opacity-100"
                          ><Plus className="size-3" /> insert</button>
                        </div>
                      )}
                    </Fragment>
                  ))}
                  <button
                    type="button" onClick={addCueAtPlayhead}
                    className="flex w-full items-center justify-center gap-2 border-t border-border px-3 py-3 text-[13px] font-medium text-accent transition hover:bg-accent/5"
                  ><Plus className="size-4" /> Add subtitle</button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">Drag the waveform to draw a cue · N add at playhead · I / O mark in/out · [ / ] set in/out · ↑ ↓ select · Space play/pause · ← → seek 5s · edits aren’t saved until you hit Save.</p>

      {saveOpen && (
        <SaveDialog
          format={format} saveName={saveName} setSaveName={setSaveName}
          saveMode={saveMode} setSaveMode={setSaveMode}
          sourceResultId={sourceResultId} sourceResultName={sourceResultName}
          saving={saving} onSave={doSave} onClose={() => setSaveOpen(false)}
        />
      )}
    </div>
  );
}

interface SaveDialogProps {
  format: Format;
  saveName: string;
  setSaveName: (v: string) => void;
  saveMode: "overwrite" | "new";
  setSaveMode: (m: "overwrite" | "new") => void;
  sourceResultId: string | null;
  sourceResultName: string;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}

/** Accessible "Save subtitles" dialog (role/focus-trap/Esc via useDialog). */
function SaveDialog(p: SaveDialogProps) {
  const dlg = useDialog<HTMLDivElement>(p.onClose);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={dlg.onBackdropMouseDown}>
      <div ref={dlg.ref} {...dlg.dialogProps} aria-label="Save subtitles" className="w-full max-w-md rounded-2xl border border-border-strong bg-surface p-5 shadow-2xl">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Save subtitles</div>
        <label className="mt-3 block text-sm">
          <span className="text-muted">File name</span>
          <div className="mt-1 flex items-center gap-2">
            <input
              autoFocus value={p.saveName} onChange={(e) => p.setSaveName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && p.saveName.trim()) p.onSave(); }}
              className="h-9 flex-1 rounded-lg border border-border-strong bg-surface-2 px-3 text-sm focus:border-accent"
            />
            <span className="font-mono text-sm text-faint">.{p.format}</span>
          </div>
        </label>

        <div className="mt-4 grid gap-2">
          <button
            type="button" disabled={!p.sourceResultId} onClick={() => p.setSaveMode("overwrite")}
            className={cn("flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left text-sm transition", p.saveMode === "overwrite" ? "border-accent bg-accent/10" : "border-border hover:border-border-strong", !p.sourceResultId && "cursor-not-allowed opacity-50")}
          >
            <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border", p.saveMode === "overwrite" ? "border-accent" : "border-border-strong")}>
              {p.saveMode === "overwrite" && <span className="size-2 rounded-full bg-accent" />}
            </span>
            <span>
              <div className="font-medium">Overwrite current file</div>
              <div className="text-xs text-muted">Replaces {p.sourceResultName ? <span className="font-mono">{p.sourceResultName}</span> : "the file you opened"}.</div>
            </span>
          </button>
          <button
            type="button" onClick={() => p.setSaveMode("new")}
            className={cn("flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left text-sm transition", p.saveMode === "new" ? "border-accent bg-accent/10" : "border-border hover:border-border-strong")}
          >
            <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border", p.saveMode === "new" ? "border-accent" : "border-border-strong")}>
              {p.saveMode === "new" && <span className="size-2 rounded-full bg-accent" />}
            </span>
            <span>
              <div className="font-medium">Save as new file</div>
              <div className="text-xs text-muted">Adds a new subtitle file to this job.</div>
            </span>
          </button>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="default" size="sm" onClick={p.onClose} disabled={p.saving}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={p.onSave} disabled={p.saving || !p.saveName.trim()}>
            {p.saving ? <Spinner className="border-accent-foreground/40 border-t-accent-foreground" /> : <Save className="size-3.5" />} Save
          </Button>
        </div>
      </div>
    </div>
  );
}
