import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Play, Pause, Plus, Trash2, Save, Download, Check } from "lucide-react";
import { useJob } from "@/api/jobs";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useWaveform } from "@/editor/useWaveform";
import {
  type Cue, parseSubtitles, displayTime, parseDisplayTime, newCue, toASS, toSRT, toVTT,
} from "@/editor/subtitles";
import { sameOriginApiUrl } from "@/lib/url";
import { subtitleFilename } from "@/lib/format";
import { cn } from "@/lib/cn";

type Format = "ass" | "srt" | "vtt";

/** Map an ASS \an (1-9 numpad) to overlay positioning. */
function anClasses(an: number): string {
  const v = an >= 7 ? "items-start" : an >= 4 ? "items-center" : "items-end";
  const h = an % 3 === 1 ? "justify-start text-left" : an % 3 === 2 ? "justify-center text-center" : "justify-end text-right";
  return `${v} ${h}`;
}

export function Editor() {
  const { id = "" } = useParams({ strict: false });
  const { data: job } = useJob(id);

  const [cues, setCues] = useState<Cue[]>([]);
  const [dims, setDims] = useState({ width: 1280, height: 720 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [format, setFormat] = useState<Format>("ass");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState(false);
  // The /video endpoint returns JSON {url} (presigned), not the bytes. Resolve it
  // to a usable media URL once, then drive both <video> and the frames decoder.
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);

  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [waveEl, setWaveEl] = useState<HTMLDivElement | null>(null);
  const cueListRef = useRef<HTMLDivElement>(null);

  // MKV / unplayable container → WebCodecs frame preview driven by a scrubber.
  const [framesMode, setFramesMode] = useState(false);
  const [framesError, setFramesError] = useState(false);
  const decRef = useRef<{ frameAt: (t: number) => Promise<ImageBitmap>; width: number; height: number } | null>(null);
  const framesCanvasRef = useRef<HTMLCanvasElement>(null);
  const duration = useMemo(() => Math.max(10, cues.reduce((m, c) => Math.max(m, c.end), 0) + 5), [cues]);

  // ---- load existing subtitles ----
  useEffect(() => {
    let stop = false;
    setLoading(true);
    (async () => {
      try {
        const results = await api.jobResults(id);
        const pick = results.find((r) => r.kind === "ass") ?? results.find((r) => r.kind === "srt") ?? results.find((r) => r.kind === "vtt");
        if (!pick) { if (!stop) { setError("This job has no subtitles to edit yet."); setLoading(false); } return; }
        const text = await fetch(sameOriginApiUrl(pick.downloadUrl), { credentials: "include" }).then((r) => r.text());
        const parsed = parseSubtitles(text, pick.kind);
        if (stop) return;
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

  // ---- resolve the source video URL (JSON {url} → usable media URL) ----
  useEffect(() => {
    let stop = false;
    setMediaUrl(null);
    setVideoError(false);
    setFramesMode(false);
    setFramesError(false);
    (async () => {
      try {
        const info = await api.jobVideo(id);
        if (!stop) setMediaUrl(sameOriginApiUrl(info.url));
      } catch {
        if (!stop) setFramesError(true); // no source at all → graceful "unavailable" fallback
      }
    })();
    return () => { stop = true; };
  }, [id]);

  const onUpdate = useCallback((cid: string, start: number, end: number) => {
    setCues((prev) => prev.map((c) => (c.id === cid ? { ...c, start, end } : c)));
    setDirty(true);
  }, []);

  const drawFrame = useCallback((bmp: ImageBitmap) => {
    const cv = framesCanvasRef.current;
    if (!cv) return;
    cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext("2d")?.drawImage(bmp, 0, 0);
  }, []);

  const seek = useCallback((t: number) => {
    if (framesMode) { setCurrentTime(t); decRef.current?.frameAt(t).then(drawFrame).catch(() => {}); return; }
    if (videoEl) videoEl.currentTime = t;
  }, [videoEl, framesMode, drawFrame]);

  // On native playback failure, fall back to decoding frames with WebCodecs.
  useEffect(() => { if (videoError) setFramesMode(true); }, [videoError]);
  useEffect(() => {
    if (!framesMode || !mediaUrl) return;
    let stop = false;
    (async () => {
      try {
        const blob = await fetch(mediaUrl, { credentials: "include" }).then((r) => r.blob());
        if (blob.type.includes("json") || blob.size < 1024) throw new Error("source video unavailable");
        const { FrameDecoder } = await import("@/editor/decodeFrame");
        const dec = new FrameDecoder();
        const bmp = await dec.init(new File([blob], "video", { type: blob.type }));
        if (stop) return;
        decRef.current = dec;
        setDims({ width: dec.width || 1280, height: dec.height || 720 });
        drawFrame(bmp);
      } catch { if (!stop) setFramesError(true); }
    })();
    return () => { stop = true; };
  }, [framesMode, mediaUrl, drawFrame]);

  const wave = useWaveform({
    media: framesMode ? null : videoEl, container: waveEl, cues, selectedId,
    onUpdate,
    onSelect: (cid) => { setSelectedId(cid); const c = cues.find((x) => x.id === cid); if (c) seek(c.start); },
  });

  // active cue (under the playhead) — drives the caption overlay + auto-scroll.
  const activeId = useMemo(() => cues.find((c) => currentTime >= c.start && currentTime < c.end)?.id ?? null, [cues, currentTime]);
  useEffect(() => {
    const el = cueListRef.current?.querySelector(`[data-cue="${activeId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const activeCue = cues.find((c) => c.id === activeId);

  function patch(cid: string, p: Partial<Cue>) { setCues((prev) => prev.map((c) => (c.id === cid ? { ...c, ...p } : c))); setDirty(true); }
  function addCue() {
    const c = newCue(currentTime, currentTime + 2);
    setCues((prev) => [...prev, c].sort((a, b) => a.start - b.start));
    setSelectedId(c.id); setDirty(true);
  }
  function delCue(cid: string) { setCues((prev) => prev.filter((c) => c.id !== cid)); setDirty(true); }

  function serialize(): string {
    return format === "ass" ? toASS(cues, dims.width, dims.height) : format === "vtt" ? toVTT(cues) : toSRT(cues);
  }
  async function save() {
    setSaving(true);
    try { await api.saveResult(id, serialize(), format, "edited"); setDirty(false); }
    finally { setSaving(false); }
  }
  function exportFile() {
    const blob = new Blob([serialize()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = subtitleFilename(job?.sourceFilename, format); a.click();
    URL.revokeObjectURL(url);
  }

  // keyboard: Space play/pause · [ / ] set in/out at playhead · ↑/↓ move selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName) || t.isContentEditable) return;
      if (e.code === "Space") { e.preventDefault(); wave.playPause(); return; }
      if (e.key === "[" && selectedId) { e.preventDefault(); patch(selectedId, { start: currentTime }); return; }
      if (e.key === "]" && selectedId) { e.preventDefault(); patch(selectedId, { end: currentTime }); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!cues.length) return;
        e.preventDefault();
        const idx = cues.findIndex((c) => c.id === selectedId);
        const ni = Math.max(0, Math.min(cues.length - 1, (idx < 0 ? 0 : idx) + (e.key === "ArrowDown" ? 1 : -1)));
        const c = cues[ni];
        if (c) { setSelectedId(c.id); seek(c.start); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [wave, selectedId, cues, currentTime, seek]);

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-6">
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
          <Button variant="ghost" size="icon" onClick={() => wave.playPause()} title="Play/Pause (Space)">
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <span className="font-mono text-xs text-muted tabular-nums">{displayTime(currentTime)}</span>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button variant="default" size="sm" onClick={addCue}><Plus className="size-3.5" /> Cue</Button>
          <Button variant="default" size="sm" disabled={!selectedId} onClick={() => selectedId && delCue(selectedId)}><Trash2 className="size-3.5" /> Delete</Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <select value={format} onChange={(e) => setFormat(e.target.value as Format)} className="h-8 rounded-lg border border-border-strong bg-surface px-2 text-[13px]">
            <option value="ass">ASS</option><option value="srt">SRT</option><option value="vtt">VTT</option>
          </select>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="default" size="sm" onClick={exportFile}><Download className="size-3.5" /> Export</Button>
            <Button variant="primary" size="sm" onClick={save} disabled={saving || !dirty}>
              {saving ? <Spinner className="border-accent-foreground/40 border-t-accent-foreground" /> : <Save className="size-3.5" />} Save
            </Button>
          </div>
        </div>

        <div className="grid lg:grid-cols-[1.55fr_1fr]">
          {/* stage: video + waveform */}
          <div className="border-border lg:border-r">
            <div className="relative aspect-video bg-black">
              <video
                ref={setVideoEl}
                src={mediaUrl ?? undefined}
                className="size-full"
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onError={() => setVideoError(true)}
                onLoadedMetadata={(e) => setDims({ width: e.currentTarget.videoWidth || 1280, height: e.currentTarget.videoHeight || 720 })}
              />
              {framesMode && !framesError && <canvas ref={framesCanvasRef} className="absolute inset-0 size-full bg-black object-contain" />}
              {framesError && (
                <div className="absolute inset-0 grid place-items-center bg-surface-2 px-6 text-center">
                  <div>
                    <div className="text-sm font-medium">Source video unavailable</div>
                    <p className="mx-auto mt-1 max-w-xs text-xs text-muted">The original video can’t be previewed (removed, or an unsupported format). Cue text and timing editing still work.</p>
                  </div>
                </div>
              )}
              {activeCue && (
                <div className={cn("pointer-events-none absolute inset-0 flex p-6", anClasses(activeCue.an))}>
                  <span className="whitespace-pre-wrap rounded bg-black/65 px-3 py-1 text-[clamp(13px,2.4vw,20px)] font-medium text-white shadow">{activeCue.text}</span>
                </div>
              )}
            </div>
            <div className="p-3">
              {framesMode ? (
                <div>
                  <input type="range" min={0} max={duration} step={0.05} value={currentTime} onChange={(e) => seek(Number(e.target.value))} className="w-full accent-amber" />
                  <div className="mt-1 text-[11px] text-faint">Frame scrubber · audio waveform unavailable for this container</div>
                </div>
              ) : (
                <>
                  <div ref={setWaveEl} className="rounded-lg border border-border bg-surface-2 p-1" />
                  <div className="mt-2 flex items-center gap-2 text-xs text-faint">
                    <input type="range" min={20} max={220} defaultValue={60} onChange={(e) => wave.zoom(Number(e.target.value))} className="w-32" />
                    <span className="font-mono">zoom</span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* cue table */}
          <div className="flex max-h-[560px] flex-col">
            <div className="grid grid-cols-[28px_88px_1fr] gap-2 border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
              <span>#</span><span>Time</span><span>Text</span>
            </div>
            <div ref={cueListRef} className="overflow-auto">
              {loading ? (
                <div className="grid place-items-center py-16"><Spinner className="size-5" /></div>
              ) : error ? (
                <p className="px-3 py-10 text-center text-sm text-muted">{error}</p>
              ) : (
                cues.map((c, i) => (
                  <div
                    key={c.id}
                    data-cue={c.id}
                    onClick={() => { setSelectedId(c.id); seek(c.start); }}
                    className={cn(
                      "grid cursor-pointer grid-cols-[28px_88px_1fr] gap-2 border-b border-border px-3 py-2 text-sm",
                      c.id === activeId && "bg-amber/10",
                      c.id === selectedId ? "bg-accent/10 shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-surface-2",
                    )}
                  >
                    <span className="pt-1 font-mono text-xs text-faint">{i + 1}</span>
                    <div className="grid gap-1" onClick={(e) => e.stopPropagation()}>
                      <input
                        defaultValue={displayTime(c.start)} key={`s-${c.id}-${c.start}`}
                        onBlur={(e) => { const v = parseDisplayTime(e.target.value); if (v != null) patch(c.id, { start: v }); }}
                        className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-[11px] text-amber hover:border-border focus:border-accent focus:bg-surface-2"
                      />
                      <input
                        defaultValue={displayTime(c.end)} key={`e-${c.id}-${c.end}`}
                        onBlur={(e) => { const v = parseDisplayTime(e.target.value); if (v != null) patch(c.id, { end: v }); }}
                        className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-[11px] text-faint hover:border-border focus:border-accent focus:bg-surface-2"
                      />
                    </div>
                    <textarea
                      defaultValue={c.text} key={`t-${c.id}`} rows={2}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => patch(c.id, { text: e.target.value })}
                      className="resize-none rounded border border-transparent bg-transparent px-1.5 py-1 text-[13px] leading-snug hover:border-border focus:border-accent focus:bg-surface-2"
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">Cue list, waveform and video stay in sync. Drag a region to retime · Space plays/pauses · edits aren’t saved until you hit Save.</p>
    </div>
  );
}
