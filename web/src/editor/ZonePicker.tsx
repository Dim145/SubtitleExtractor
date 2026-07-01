import { useCallback, useEffect, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import { useNavigate } from "@tanstack/react-router";
import { X, Plus, Server, Cpu } from "lucide-react";
import { useCreateJob } from "@/api/jobs";
import { webGpuAvailable, webCodecsAvailable } from "@/clientside/_caps";
import type { Zone } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useDialog } from "@/components/ui/useDialog";
import { subtitleFilename } from "@/lib/format";
import { cn } from "@/lib/cn";
import { loadZones, saveZones, loadLang, saveLang, loadAutoZone, saveAutoZone } from "@/lib/zonePrefs";

// OCR language hint sent to the server job ("" = auto-detect).
const LANGUAGES: { code: string; label: string }[] = [
  { code: "", label: "Auto-detect" },
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "ch", label: "中文" },
  { code: "ar", label: "العربية" },
];
import { toSRT, toASS, toVTT } from "@/editor/subtitles";
import { useSourcePlayer } from "@/editor/player/useSourcePlayer";
import { usePlayerHotkeys } from "@/editor/player/usePlayerHotkeys";
import { MediaStage } from "@/editor/player/MediaStage";

const FORMATS = ["srt", "ass", "vtt"] as const;
type Fmt = (typeof FORMATS)[number];

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/** Pick subtitle zones over a playable preview, then extract on the server or in
 * the browser. The preview uses the shared player (native <video>, or WebCodecs
 * for MKV/HEVC) so it has play/pause, a seek bar and keyboard transport. */
export function ZonePicker({ file, onClose }: { file: File; onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateJob();
  const stageRef = useRef<HTMLDivElement>(null);
  const dlg = useDialog<HTMLDivElement>(onClose);

  const player = useSourcePlayer({ file });
  usePlayerHotkeys(player);
  const ready = player.mode === "video" || player.mode === "canvas";

  // Re-render when the stage resizes so zone rectangles (read from clientWidth/
  // clientHeight below) track the frame instead of drifting.
  const [, setStageSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStageSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [ready]);

  // Zone layout is remembered across extractions (localStorage).
  const [zones, setZones] = useState<Zone[]>(loadZones);
  useEffect(() => { saveZones(zones); }, [zones]);
  const [autoZone, setAutoZone] = useState<boolean>(loadAutoZone);
  useEffect(() => { saveAutoZone(autoZone); }, [autoZone]);
  const [language, setLanguage] = useState<string>(loadLang);
  useEffect(() => { saveLang(language); }, [language]);
  const [formats, setFormats] = useState<Set<Fmt>>(new Set<Fmt>(["srt", "ass"]));
  const [progress, setProgress] = useState<{ pct: number; stage: string } | null>(null);

  const toggle = (f: Fmt) => setFormats((s) => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; });

  // ---- server extraction ----
  function extractServer() {
    const form = new FormData();
    form.append("file", file);
    form.append("formats", [...formats].join(","));
    if (language) form.append("language", language);
    if (autoZone) {
      form.append("auto_zone", "true");
    } else if (zones.length) {
      form.append("zones", JSON.stringify(zones));
    }
    create.mutate(form, { onSuccess: () => { onClose(); navigate({ to: "/" }); } });
  }

  // ---- in-browser extraction ----
  const [busy, setBusy] = useState(false);
  async function extractBrowser() {
    setBusy(true);
    setProgress({ pct: 0, stage: "starting" });
    try {
      const { extractInBrowser } = await import("@/clientside/clientOcr");
      const res = await extractInBrowser(file, { zones, autoZone, fps: 4 }, (pct, stage) => setProgress({ pct, stage }));
      for (const f of formats) {
        const body = f === "srt" ? toSRT(res.cues) : f === "ass" ? toASS(res.cues, res.width, res.height) : toVTT(res.cues);
        download(subtitleFilename(file.name, f), body);
      }
      onClose();
    } catch (e) {
      setProgress({ pct: 0, stage: e instanceof Error ? e.message : "failed" });
    } finally {
      setBusy(false);
    }
  }

  // normalize a px rect (in stage coords) to 0..1
  const norm = useCallback((px: { x: number; y: number; width: number; height: number }): Zone => {
    const el = stageRef.current;
    const W = el?.clientWidth || 1, H = el?.clientHeight || 1;
    return {
      x: Math.max(0, Math.min(1, px.x / W)),
      y: Math.max(0, Math.min(1, px.y / H)),
      w: Math.max(0.02, Math.min(1, px.width / W)),
      h: Math.max(0.02, Math.min(1, px.height / H)),
    };
  }, []);

  const stageW = stageRef.current?.clientWidth || 0;
  const stageH = stageRef.current?.clientHeight || 0;

  const zoneOverlay = !autoZone && ready && stageW > 0 ? zones.map((z, i) => (
    <Rnd
      key={i}
      bounds="parent"
      size={{ width: z.w * stageW, height: z.h * stageH }}
      position={{ x: z.x * stageW, y: z.y * stageH }}
      onDragStop={(_e, d) => setZones((zs) => zs.map((zz, idx) => idx === i ? norm({ x: d.x, y: d.y, width: z.w * stageW, height: z.h * stageH }) : zz))}
      onResizeStop={(_e, _dir, ref, _delta, pos) => setZones((zs) => zs.map((zz, idx) => idx === i ? norm({ x: pos.x, y: pos.y, width: ref.offsetWidth, height: ref.offsetHeight }) : zz))}
      className="z-10"
    >
      <div className={`relative size-full rounded ${i === 0 ? "border-2 border-accent" : "border-2 border-amber"}`}>
        <span className={`absolute -top-2.5 left-1.5 rounded px-1.5 text-[9px] font-bold text-[#04181c] ${i === 0 ? "bg-accent" : "bg-amber"}`}>ZONE {i === 0 ? "A" : "B"}</span>
        <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setZones((zs) => zs.filter((_, idx) => idx !== i))}
          aria-label={`Remove zone ${i === 0 ? "A" : "B"}`}
          className="absolute -right-2.5 -top-2.5 z-20 grid size-7 place-items-center rounded-full bg-surface text-err shadow sm:size-5"><X className="size-3" /></button>
      </div>
    </Rnd>
  )) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/60 p-4 backdrop-blur-sm" onMouseDown={dlg.onBackdropMouseDown}>
      <div ref={dlg.ref} {...dlg.dialogProps} aria-label="New extraction" className="my-6 w-full max-w-3xl rounded-2xl border border-border-strong bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">New extraction</div>
            <div className="truncate text-sm font-medium">{file.name}</div>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}><X className="size-4" /></Button>
        </div>

        <div className="p-5">
          <p className="mb-2 text-sm text-muted">{autoZone
            ? "La zone des sous-titres est détectée automatiquement. Play/seek to preview the frame."
            : "Draw up to 2 subtitle zones over the frame (or leave the default band). Play/seek to find a frame with subtitles."}</p>
          <MediaStage
            player={player}
            stageRef={stageRef}
            overlay={zoneOverlay}
            className="overflow-hidden rounded-lg border border-border"
            unavailable={
              <div>
                <div className="text-sm text-muted">Preview unavailable in this browser.</div>
                <div className="mt-1 text-xs text-faint">Set zones by ratio and extract — it still works.</div>
                {player.error && <div className="mt-2 break-words font-mono text-[10px] text-faint/70">{player.error}</div>}
              </div>
            }
          />

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-3">
            <label className="flex items-center gap-2 text-sm text-muted">
              <Switch checked={autoZone} onCheckedChange={setAutoZone} id="autozone" aria-label="Zone auto" />
              <span>Zone auto</span>
            </label>
            {!autoZone && (
              <Button variant="default" size="sm" disabled={zones.length >= 2} onClick={() => setZones((z) => [...z, { x: 0.3, y: 0.1, w: 0.4, h: 0.14 }])}><Plus className="size-3.5" /> Add zone</Button>
            )}
            <div className="flex items-center gap-1.5">
              {FORMATS.map((f) => (
                <button
                  key={f} type="button" onClick={() => toggle(f)}
                  aria-pressed={formats.has(f)}
                  className={cn(
                    "rounded-lg border px-2.5 py-1 text-xs font-semibold transition",
                    formats.has(f) ? "border-accent bg-accent/15 text-accent" : "border-border-strong text-muted hover:border-accent/50 hover:text-fg",
                  )}
                >{f.toUpperCase()}</button>
              ))}
            </div>
            <label className="ml-auto flex items-center gap-2 text-sm text-muted">
              Language
              <select
                value={language} onChange={(e) => setLanguage(e.target.value)}
                title="OCR language hint (server extraction)"
                className="h-8 rounded-lg border border-border-strong bg-surface px-2 text-[13px]"
              >
                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </label>
          </div>

          {autoZone && <p className="mt-2 text-xs text-faint">La zone des sous-titres est détectée automatiquement.</p>}

          {progress && <div className="mt-3 text-xs text-muted"><span className="font-mono">{progress.pct}%</span> · {progress.stage}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="default" onClick={extractServer} disabled={create.isPending || busy || formats.size === 0}>
            {create.isPending ? <Spinner /> : <Server className="size-4" />} Extract on server
          </Button>
          <Button variant="primary" onClick={extractBrowser} disabled={busy || create.isPending || formats.size === 0 || !webCodecsAvailable()}
            title={webGpuAvailable() ? "Runs locally on WebGPU" : "Runs locally (WebGPU not detected — slower)"}>
            {busy ? <Spinner className="border-accent-foreground/40 border-t-accent-foreground" /> : <Cpu className="size-4" />} Extract in browser
          </Button>
        </div>
      </div>
    </div>
  );
}
