import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Trash2, Save, Download, Check, X } from "lucide-react";
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
import { sameOriginApiUrl } from "@/lib/url";
import { subtitleFilename } from "@/lib/format";
import { cn } from "@/lib/cn";

type Format = "ass" | "srt" | "vtt";

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

  const [waveEl, setWaveEl] = useState<HTMLDivElement | null>(null);
  const cueListRef = useRef<HTMLDivElement>(null);

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
        const text = await fetch(sameOriginApiUrl(pick.downloadUrl), { credentials: "include" }).then((r) => r.text());
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
        if (!stop) setMediaUrl(sameOriginApiUrl(info.url));
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

  const caption = activeCue ? (
    <div className={cn("pointer-events-none absolute inset-0 flex p-6", anClasses(activeCue.an))}>
      <span className="whitespace-pre-wrap rounded bg-black/65 px-3 py-1 text-[clamp(13px,2.4vw,20px)] font-medium text-white shadow">{activeCue.text}</span>
    </div>
  ) : null;

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
          <Button variant="default" size="sm" onClick={addCue}><Plus className="size-3.5" /> Cue</Button>
          <Button variant="default" size="sm" disabled={!selectedId} onClick={() => selectedId && delCue(selectedId)}><Trash2 className="size-3.5" /> Delete</Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <select value={format} onChange={(e) => setFormat(e.target.value as Format)} className="h-8 rounded-lg border border-border-strong bg-surface px-2 text-[13px]">
            <option value="ass">ASS</option><option value="srt">SRT</option><option value="vtt">VTT</option>
          </select>
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
                <div className="text-[11px] text-faint">Frame preview · audio waveform unavailable for this container</div>
              ) : null}
            </div>
          </div>

          {/* cue table */}
          <div className="flex max-h-[560px] flex-col">
            <div className="grid grid-cols-[28px_88px_1fr_32px] gap-2 border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
              <span>#</span><span>Time</span><span>Text</span><span />
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
                    onClick={() => { setSelectedId(c.id); player.seek(c.start); }}
                    className={cn(
                      "grid cursor-pointer grid-cols-[28px_88px_1fr_32px] gap-2 border-b border-border px-3 py-2 text-sm",
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
                    <button
                      type="button" title="Delete cue"
                      onClick={(e) => { e.stopPropagation(); delCue(c.id); }}
                      className="grid size-6 self-start place-items-center rounded text-faint transition hover:bg-err/15 hover:text-err"
                    ><X className="size-4" /></button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">Cue list, waveform and video stay in sync · Space play/pause · ← → seek 5s · [ / ] set in/out · ↑ ↓ select · edits aren’t saved until you hit Save.</p>

      {saveOpen && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) setSaveOpen(false); }}>
          <div className="w-full max-w-md rounded-2xl border border-border-strong bg-surface p-5 shadow-2xl">
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">Save subtitles</div>
            <label className="mt-3 block text-sm">
              <span className="text-muted">File name</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && saveName.trim()) doSave(); }}
                  className="h-9 flex-1 rounded-lg border border-border-strong bg-surface-2 px-3 text-sm focus:border-accent"
                />
                <span className="font-mono text-sm text-faint">.{format}</span>
              </div>
            </label>

            <div className="mt-4 grid gap-2">
              <button
                type="button" disabled={!sourceResultId} onClick={() => setSaveMode("overwrite")}
                className={cn("flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left text-sm transition", saveMode === "overwrite" ? "border-accent bg-accent/10" : "border-border hover:border-border-strong", !sourceResultId && "cursor-not-allowed opacity-50")}
              >
                <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border", saveMode === "overwrite" ? "border-accent" : "border-border-strong")}>
                  {saveMode === "overwrite" && <span className="size-2 rounded-full bg-accent" />}
                </span>
                <span>
                  <div className="font-medium">Overwrite current file</div>
                  <div className="text-xs text-muted">Replaces {sourceResultName ? <span className="font-mono">{sourceResultName}</span> : "the file you opened"}.</div>
                </span>
              </button>
              <button
                type="button" onClick={() => setSaveMode("new")}
                className={cn("flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left text-sm transition", saveMode === "new" ? "border-accent bg-accent/10" : "border-border hover:border-border-strong")}
              >
                <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border", saveMode === "new" ? "border-accent" : "border-border-strong")}>
                  {saveMode === "new" && <span className="size-2 rounded-full bg-accent" />}
                </span>
                <span>
                  <div className="font-medium">Save as new file</div>
                  <div className="text-xs text-muted">Adds a new subtitle file to this job.</div>
                </span>
              </button>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="default" size="sm" onClick={() => setSaveOpen(false)} disabled={saving}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={doSave} disabled={saving || !saveName.trim()}>
                {saving ? <Spinner className="border-accent-foreground/40 border-t-accent-foreground" /> : <Save className="size-3.5" />} Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
