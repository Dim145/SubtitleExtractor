import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2, Save, Download, Check, X, ChevronDown, ArrowUpToLine, ArrowDownToLine, TriangleAlert, ArrowLeftRight, RotateCcw } from "lucide-react";
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
import { useToast } from "@/components/ui/toast";

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
  const toast = useToast();

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
  // Timing shift: a global offset applied to every cue (live). shiftTotal tracks
  // the session's accumulated shift so it can be reset.
  const [shiftOpen, setShiftOpen] = useState(false);
  const [shiftInput, setShiftInput] = useState("-1.000");
  const [shiftTotal, setShiftTotal] = useState(0);

  const [waveEl, setWaveEl] = useState<HTMLDivElement | null>(null);
  // Polite screen-reader announcements (cue created, etc.).
  const [announce, setAnnounce] = useState("");
  const [zoomPx, setZoomPx] = useState(60); // waveform zoom (px/sec) for aria-valuetext
  const [helpOpen, setHelpOpen] = useState(false); // keyboard-shortcuts legend
  // Small-screen (< lg) pane switch. Both panes stay mounted (toggled via CSS,
  // not conditional render) so switching never resets the player or waveform.
  const [mobileTab, setMobileTab] = useState<"video" | "cues">("video");
  // Keys ("s-<id>" / "e-<id>") of timecode fields whose last blur failed to
  // parse — drives an inline red border so the drop isn't silent (item 21).
  const [invalidTimes, setInvalidTimes] = useState<Set<string>>(new Set());
  const markTimeValid = (key: string, valid: boolean) =>
    setInvalidTimes((prev) => {
      if (valid === !prev.has(key)) return prev;
      const next = new Set(prev);
      if (valid) next.delete(key); else next.add(key);
      return next;
    });
  const cueListRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const shiftRef = useRef<HTMLDivElement>(null);

  // One unified player (native <video>, or WebCodecs frames for MKV/HEVC).
  const player = useSourcePlayer({ url: mediaUrl });
  usePlayerHotkeys(player);
  const currentTime = player.currentTime;

  // currentTime in a ref so editing hotkeys don't rebind on every frame.
  const timeRef = useRef(0);
  timeRef.current = currentTime;

  // Chronologically-sorted view of the cues for display + active lookup. The
  // `cues` state isn't re-sorted on every timing patch, so anything positional
  // (row numbers, overlay, active highlight, ↑/↓ navigation) reads this instead.
  const sortedCues = useMemo(() => [...cues].sort((a, b) => a.start - b.start), [cues]);

  // Latest cues/selection in refs so the global keydown handler binds once
  // (mirrors the timeRef pattern) instead of rebinding on every keystroke.
  const sortedRef = useRef(sortedCues);
  sortedRef.current = sortedCues;
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;

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
  // Latest `wave` in a ref so the once-bound keydown handler can scroll the
  // waveform to a keyboard-selected cue without rebinding every render.
  const waveRef = useRef(wave);
  waveRef.current = wave;

  /** Select a cue by id: seek the playhead there AND scroll its waveform region
   * into view (the region's selected color is applied by useWaveform's sync). */
  const selectCue = useCallback((cid: string) => {
    const c = sortedRef.current.find((x) => x.id === cid);
    if (!c) return;
    setSelectedId(cid);
    player.seek(c.start);
    waveRef.current.scrollToTime(c.start);
  }, [player.seek]);

  // active cue (under the playhead) — drives the caption overlay + auto-scroll.
  const activeId = useMemo(() => sortedCues.find((c) => currentTime >= c.start && currentTime < c.end)?.id ?? null, [sortedCues, currentTime]);
  useEffect(() => {
    const el = cueListRef.current?.querySelector(`[data-cue="${activeId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  const activeCue = sortedCues.find((c) => c.id === activeId);
  const selectedCue = useMemo(() => cues.find((c) => c.id === selectedId) ?? null, [cues, selectedId]);
  // The waveform is a graphical control; screen readers get the selection state
  // through its accessible name (updated here) + the polite announcement below.
  const waveLabel = selectedCue
    ? `Subtitle timeline. Selected cue ${displayTime(selectedCue.start)} to ${displayTime(selectedCue.end)}${selectedCue.text ? `: ${selectedCue.text}` : ""}`
    : "Subtitle timeline. No cue selected";
  // Announce the selection (id-keyed so it only fires when the cue actually
  // changes, not on every edge nudge which keeps the same id).
  const lastAnnouncedSel = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedCue) { lastAnnouncedSel.current = null; return; }
    if (lastAnnouncedSel.current === selectedCue.id) return;
    lastAnnouncedSel.current = selectedCue.id;
    setAnnounce(`Selected cue ${displayTime(selectedCue.start)} to ${displayTime(selectedCue.end)}${selectedCue.text ? `: ${selectedCue.text}` : ""}`);
  }, [selectedCue]);

  // Cues OCR flagged as low-confidence — surfaced as a "N to review" chip.
  const lowConfCount = useMemo(() => cues.filter(isLowConfidence).length, [cues]);
  /** Select and scroll to the first low-confidence cue. */
  function reviewFirstLowConf() {
    const c = [...cues].sort((a, b) => a.start - b.start).find(isLowConfidence);
    if (!c) return;
    selectCue(c.id);
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
    setAnnounce(`Cue added at ${displayTime(s)}.`);
  }
  /** Add at the playhead, clamped so it doesn't overrun the next cue. */
  function addCueAtPlayhead() {
    const t = timeRef.current;
    // Read the latest cues via the ref so the once-bound keydown handler (N) and
    // late clicks both see current state, not a stale render-time snapshot.
    const next = sortedRef.current.find((c) => c.start > t);
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

  /** Shift every cue's timing by `delta` seconds (live preview; clamped at 0). */
  function shiftAll(delta: number) {
    if (!delta || !cues.length) return;
    setCues((prev) => prev.map((c) => {
      const start = Math.max(0, c.start + delta);
      return { ...c, start, end: Math.max(start, c.end + delta) };
    }));
    setShiftTotal((t) => t + delta);
    setDirty(true);
  }
  /** Apply the exact amount typed in the shift field (seconds, e.g. -1.25). */
  function applyShiftInput() {
    const v = parseFloat(shiftInput.replace(",", "."));
    if (Number.isFinite(v) && v !== 0) shiftAll(v);
  }

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
      toast.success("Subtitles saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally { setSaving(false); }
  }
  function exportFile() {
    const blob = new Blob([serialize()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = subtitleFilename(job?.sourceFilename, format); a.click();
    // Defer the revoke so the click-driven download isn't aborted.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success("Subtitle file exported.");
  }

  // Editing keys ([ / ] set in/out at the playhead · ↑/↓ move selection ·
  // , / . nudge the selected cue's in/out (Shift = coarser step) · Alt+, / Alt+.
  // slide the whole selected cue earlier/later).
  // Transport keys (Space, ← →, Home) live in usePlayerHotkeys, shared site-wide.
  // Reads cues/selection via refs so it binds ONCE (not on every keystroke).
  const nudgeSelected = useCallback((edge: "start" | "end", delta: number) => {
    const sel = selectedRef.current;
    if (!sel) return;
    setCues((prev) => prev.map((c) => {
      if (c.id !== sel) return c;
      if (edge === "start") return { ...c, start: Math.max(0, Math.min(c.start + delta, c.end - 0.05)) };
      return { ...c, end: Math.max(c.end + delta, c.start + 0.05) };
    }));
    setDirty(true);
  }, []);
  /** Shift the whole selected cue (start+end together) by `delta`, clamped at 0. */
  const moveSelected = useCallback((delta: number) => {
    const sel = selectedRef.current;
    if (!sel) return;
    setCues((prev) => prev.map((c) => {
      if (c.id !== sel) return c;
      const start = Math.max(0, c.start + delta);
      return { ...c, start, end: start + (c.end - c.start) };
    }));
    setDirty(true);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName) || t.isContentEditable) return;
      const sel = selectedRef.current;
      const list = sortedRef.current;
      if (e.key === "[" && sel) { e.preventDefault(); patch(sel, { start: timeRef.current }); return; }
      if (e.key === "]" && sel) { e.preventDefault(); patch(sel, { end: timeRef.current }); return; }
      if ((e.key === "," || e.key === ".") && sel) {
        e.preventDefault();
        // Alt = slide the whole cue; otherwise nudge one edge (Shift = coarser).
        if (e.altKey) { moveSelected(e.key === "," ? -0.05 : 0.05); return; }
        const step = e.shiftKey ? 0.5 : 0.05;
        nudgeSelected(e.key === "," ? "start" : "end", e.key === "," ? -step : step);
        return;
      }
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
        if (!list.length) return;
        e.preventDefault();
        const idx = list.findIndex((c) => c.id === sel);
        const ni = Math.max(0, Math.min(list.length - 1, (idx < 0 ? 0 : idx) + (e.key === "ArrowDown" ? 1 : -1)));
        const c = list[ni];
        if (c) selectCue(c.id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // selectCue/nudgeSelected/moveSelected are stable (useCallback); binds once.
  }, [selectCue, nudgeSelected, moveSelected]);

  // Close the add-menu when clicking outside it.
  useEffect(() => {
    if (!addMenu) return;
    const onDoc = (e: MouseEvent) => { if (!addRef.current?.contains(e.target as Node)) setAddMenu(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [addMenu]);

  // Close the shift popover when clicking outside it.
  useEffect(() => {
    if (!shiftOpen) return;
    const onDoc = (e: MouseEvent) => { if (!shiftRef.current?.contains(e.target as Node)) setShiftOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [shiftOpen]);

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
        <div className="flex items-center gap-2 text-xs" aria-live="polite">
          {dirty ? <span className="text-amber">● Unsaved</span> : <span className="flex items-center gap-1 text-ok"><Check className="size-3.5" /> Saved</span>}
        </div>
      </div>
      {/* Polite live region for cue-creation and similar announcements. */}
      <div aria-live="polite" className="sr-only">{announce}</div>

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

          <div ref={shiftRef} className="relative">
            <Button
              variant="default" size="sm" aria-haspopup="dialog" aria-expanded={shiftOpen} disabled={!cues.length}
              onClick={() => setShiftOpen((o) => !o)} title="Shift the timing of all subtitles"
            ><ArrowLeftRight className="size-3.5" /> Shift</Button>
            {shiftOpen && (
              <div role="dialog" aria-label="Shift all subtitle timing"
                className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-border-strong bg-surface p-3 shadow-xl">
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Shift all subtitles</div>
                <p className="mt-1 text-[11px] text-muted">Move every cue earlier (−) or later (+). Live, on all {cues.length} cues.</p>
                <div className="mt-2 grid grid-cols-6 gap-1">
                  {[-1, -0.5, -0.1, 0.1, 0.5, 1].map((d) => (
                    <button
                      key={d} type="button" onClick={() => shiftAll(d)}
                      aria-label={`Shift ${d > 0 ? "later" : "earlier"} by ${Math.abs(d)} seconds`}
                      className="rounded-md border border-border-strong bg-surface-2 py-1 font-mono text-[11px] transition hover:border-accent"
                    >{d > 0 ? "+" : ""}{d}s</button>
                  ))}
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <input
                    value={shiftInput} onChange={(e) => setShiftInput(e.target.value)} inputMode="decimal"
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyShiftInput(); } }}
                    aria-label="Exact shift in seconds (e.g. -1.25)"
                    className="h-8 w-24 rounded-lg border border-border-strong bg-surface-2 px-2 font-mono text-[13px] outline-none focus:border-accent"
                  />
                  <span className="text-[11px] text-faint">seconds</span>
                  <Button variant="primary" size="sm" className="ml-auto" onClick={applyShiftInput}>Apply</Button>
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-[11px]">
                  <span className="text-muted">Session: <span className="font-mono text-amber">{shiftTotal >= 0 ? "+" : ""}{shiftTotal.toFixed(3)}s</span></span>
                  <button
                    type="button" disabled={shiftTotal === 0} onClick={() => shiftAll(-shiftTotal)}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-faint transition hover:text-text disabled:opacity-40 disabled:hover:text-faint"
                  ><RotateCcw className="size-3" /> Reset</button>
                </div>
              </div>
            )}
          </div>
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

        {/* Small-screen pane switch. Hidden at lg+, where both panes show side
            by side. Arrow-key navigable per the tablist pattern. */}
        <div
          role="tablist" aria-label="Editor panes"
          className="flex gap-1 border-b border-border bg-surface-2 p-1.5 lg:hidden"
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const next = mobileTab === "video" ? "cues" : "video";
            setMobileTab(next);
            // Roving focus: move to the newly-selected tab (it becomes tabbable).
            document.getElementById(`editor-tab-${next}`)?.focus();
          }}
        >
          {(["video", "cues"] as const).map((tab) => {
            const selected = mobileTab === tab;
            return (
              <button
                key={tab} type="button" role="tab" id={`editor-tab-${tab}`}
                aria-selected={selected} aria-controls={`editor-panel-${tab}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setMobileTab(tab)}
                className={cn(
                  "h-9 flex-1 rounded-lg border text-[13px] font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  selected ? "border-accent bg-accent/10 text-accent" : "border-border-strong bg-surface text-muted hover:text-text",
                )}
              >
                {tab === "video" ? "Video" : `Cues${cues.length ? ` (${cues.length})` : ""}`}
              </button>
            );
          })}
        </div>

        <div className="grid lg:grid-cols-[1.55fr_1fr]">
          {/* stage: player + waveform */}
          <div
            role="tabpanel" id="editor-panel-video" aria-labelledby="editor-tab-video"
            className={cn("border-border lg:block lg:border-r", mobileTab === "video" ? "block" : "hidden lg:block")}
          >
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
                  <div
                    ref={setWaveEl} tabIndex={0} role="group" aria-label={waveLabel}
                    aria-keyshortcuts="ArrowUp ArrowDown Comma Period Shift+Comma Shift+Period Alt+Comma Alt+Period BracketLeft BracketRight N I O"
                    className="rounded-lg border border-border bg-surface-2 p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  />
                  <div className="mt-2 flex items-center gap-2 text-xs text-faint">
                    <label htmlFor="wave-zoom" className="font-mono">zoom</label>
                    <input
                      id="wave-zoom" type="range" min={20} max={220} defaultValue={60}
                      aria-label="Waveform zoom" aria-valuetext={`${zoomPx} pixels per second`}
                      onChange={(e) => { const v = Number(e.target.value); setZoomPx(v); wave.zoom(v); }}
                      className="w-32"
                    />
                  </div>
                </>
              ) : player.mode === "canvas" ? (
                <div className="text-xs text-muted">Frame preview · audio waveform unavailable for this container</div>
              ) : null}
            </div>
          </div>

          {/* cue table. Below lg it takes natural height (no fixed max-h that
              would trap it in a tiny scroller on small screens). Wrapped in a
              tabpanel so the mobile switch can show/hide it via CSS (kept mounted
              so cue edits and scroll position survive tab switches). */}
          <div
            role="tabpanel" id="editor-panel-cues" aria-labelledby="editor-tab-cues"
            className={cn("min-h-0 flex-col lg:flex", mobileTab === "cues" ? "flex" : "hidden lg:flex")}
          >
          <div className="flex flex-col lg:max-h-[560px]" role="grid" aria-label="Subtitle cues" aria-rowcount={sortedCues.length} aria-keyshortcuts="ArrowUp ArrowDown Comma Period Alt+Comma Alt+Period N I O">
            <div role="row" className="grid grid-cols-[28px_88px_1fr_40px] gap-2 border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint sm:grid-cols-[28px_88px_1fr_32px]">
              <span role="columnheader">#</span><span role="columnheader">Time</span><span role="columnheader">Text</span><span role="columnheader" aria-label="Actions" />
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
                  {sortedCues.map((c, i) => (
                    <Fragment key={c.id}>
                      <div
                        data-cue={c.id} role="row" aria-rowindex={i + 1}
                        aria-selected={c.id === selectedId}
                        onClick={() => selectCue(c.id)}
                        className={cn(
                          "grid cursor-pointer grid-cols-[28px_88px_1fr_40px] gap-2 border-b border-border px-3 py-2 text-sm sm:grid-cols-[28px_88px_1fr_32px]",
                          c.id === activeId && "bg-amber/10",
                          // Faint amber left accent for OCR low-confidence cues (yields to the selected accent below).
                          isLowConfidence(c) && c.id !== selectedId && "bg-amber/[0.06] shadow-[inset_2px_0_0_var(--amber)]",
                          c.id === selectedId ? "bg-accent/10 shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-surface-2",
                        )}
                      >
                        <span role="gridcell" className="flex items-start gap-1 pt-1 font-mono text-xs text-faint">
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
                        <div role="gridcell" className="grid gap-1" onClick={(e) => e.stopPropagation()}>
                          <input
                            defaultValue={displayTime(c.start)} key={`s-${c.id}-${c.start}`}
                            inputMode="decimal" aria-label={`Cue ${i + 1} start time`}
                            aria-invalid={invalidTimes.has(`s-${c.id}`) || undefined}
                            onBlur={(e) => {
                              const v = parseDisplayTime(e.target.value);
                              if (v != null) { markTimeValid(`s-${c.id}`, true); patch(c.id, { start: v }); }
                              else { markTimeValid(`s-${c.id}`, false); e.target.value = displayTime(c.start); } // revert visibly
                            }}
                            className={cn(
                              "w-full rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-[16px] text-amber hover:border-border focus:border-accent focus:bg-surface-2 sm:text-[13px]",
                              invalidTimes.has(`s-${c.id}`) && "border-err",
                            )}
                          />
                          <input
                            defaultValue={displayTime(c.end)} key={`e-${c.id}-${c.end}`}
                            inputMode="decimal" aria-label={`Cue ${i + 1} end time`}
                            aria-invalid={invalidTimes.has(`e-${c.id}`) || undefined}
                            onBlur={(e) => {
                              const v = parseDisplayTime(e.target.value);
                              if (v != null) { markTimeValid(`e-${c.id}`, true); patch(c.id, { end: v }); }
                              else { markTimeValid(`e-${c.id}`, false); e.target.value = displayTime(c.end); } // revert visibly
                            }}
                            className={cn(
                              "w-full rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-[16px] text-faint hover:border-border focus:border-accent focus:bg-surface-2 sm:text-[13px]",
                              invalidTimes.has(`e-${c.id}`) && "border-err",
                            )}
                          />
                        </div>
                        <textarea
                          defaultValue={c.text} key={`t-${c.id}`} rows={2} role="gridcell"
                          aria-label={`Cue ${i + 1} text`}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => patch(c.id, { text: e.target.value })}
                          className="resize-none rounded border border-transparent bg-transparent px-1.5 py-1 text-[13px] leading-snug hover:border-border focus:border-accent focus:bg-surface-2"
                        />
                        <button
                          type="button" title="Delete cue" aria-label={`Delete cue ${i + 1}`} role="gridcell"
                          onClick={(e) => { e.stopPropagation(); delCue(c.id); }}
                          className="grid size-9 self-start place-items-center rounded text-faint transition hover:bg-err/15 hover:text-err sm:size-7"
                        ><X className="size-4" /></button>
                      </div>
                      {i < sortedCues.length - 1 && (
                        <div className="group/ins relative h-1.5">
                          <button
                            type="button" aria-label={`Insert a cue between ${i + 1} and ${i + 2}`}
                            onClick={() => insertBetween(c.end, sortedCues[i + 1].start)}
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
      </div>
      <div className="relative mt-2 flex items-center gap-2 text-xs text-muted">
        <span>Drag the waveform to draw a cue. Edits aren’t saved until you hit Save.</span>
        <button
          type="button" aria-haspopup="dialog" aria-expanded={helpOpen}
          onClick={() => setHelpOpen((o) => !o)}
          className="grid size-5 shrink-0 place-items-center rounded-full border border-border-strong font-mono text-[11px] text-faint transition hover:border-accent hover:text-accent"
        >?</button>
        {helpOpen && (
          <div role="dialog" aria-label="Keyboard shortcuts"
            className="absolute bottom-full left-0 z-30 mb-2 w-80 rounded-lg border border-border-strong bg-surface p-3 shadow-xl">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Keyboard shortcuts</div>
              <button type="button" aria-label="Close shortcuts" onClick={() => setHelpOpen(false)} className="grid size-5 place-items-center rounded text-faint hover:bg-surface-2 hover:text-text"><X className="size-3.5" /></button>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-faint">Transport</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                  <dt><kbd className="font-mono text-accent">Space</kbd></dt><dd>Play / pause</dd>
                  <dt><kbd className="font-mono text-accent">← →</kbd></dt><dd>Seek ±5s</dd>
                </dl>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-faint">Editing</div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                  <dt><kbd className="font-mono text-accent">N</kbd></dt><dd>Add cue at playhead</dd>
                  <dt><kbd className="font-mono text-accent">I</kbd> / <kbd className="font-mono text-accent">O</kbd></dt><dd>Mark in / out (then create cue)</dd>
                  <dt><kbd className="font-mono text-accent">[</kbd> / <kbd className="font-mono text-accent">]</kbd></dt><dd>Set in / out at playhead</dd>
                  <dt><kbd className="font-mono text-accent">,</kbd> / <kbd className="font-mono text-accent">.</kbd></dt><dd>Nudge in / out (Shift = coarser)</dd>
                  <dt><kbd className="font-mono text-accent">Alt</kbd>+<kbd className="font-mono text-accent">,</kbd> / <kbd className="font-mono text-accent">.</kbd></dt><dd>Slide whole cue earlier / later</dd>
                  <dt><kbd className="font-mono text-accent">↑ ↓</kbd></dt><dd>Select prev / next cue (scrolls waveform)</dd>
                </dl>
              </div>
            </div>
          </div>
        )}
      </div>

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
