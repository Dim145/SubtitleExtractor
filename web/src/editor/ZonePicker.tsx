import { useCallback, useEffect, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import { useNavigate } from "@tanstack/react-router";
import { X, Plus, Server, Cpu } from "lucide-react";
import { useCreateJob } from "@/api/jobs";
import { webGpuAvailable, webCodecsAvailable } from "@/clientside/_caps";
import type { Zone } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { subtitleFilename } from "@/lib/format";
import { toSRT, toASS, toVTT } from "@/editor/subtitles";

const FORMATS = ["srt", "ass", "vtt"] as const;
type Fmt = (typeof FORMATS)[number];

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

/** Pick subtitle zones over a still frame, then extract on the server or in the
 * browser. Frame is decoded via WebCodecs (works for MP4 and MKV). */
export function ZonePicker({ file, onClose }: { file: File; onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateJob();
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [ready, setReady] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [zones, setZones] = useState<Zone[]>([{ x: 0.06, y: 0.7, w: 0.88, h: 0.22 }]);
  const [formats, setFormats] = useState<Set<Fmt>>(new Set<Fmt>(["srt", "ass"]));
  const [progress, setProgress] = useState<{ pct: number; stage: string } | null>(null);

  // Decode one representative frame for the backdrop.
  useEffect(() => {
    let stop = false;
    (async () => {
      if (!webCodecsAvailable()) { setPreviewErr("This browser has no WebCodecs video decoder."); setReady(true); return; }
      let dec: import("@/editor/decodeFrame").FrameDecoder | null = null;
      try {
        const { FrameDecoder } = await import("@/editor/decodeFrame");
        dec = new FrameDecoder();
        const bmp = await dec.init(file); // init() decodes & returns a representative frame
        if (stop) return;
        const cv = canvasRef.current;
        if (cv) { cv.width = dec.width; cv.height = dec.height; cv.getContext("2d")?.drawImage(bmp, 0, 0); }
        setReady(true);
      } catch (e) {
        console.error("[ZonePicker] frame decode failed:", e);
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
        if (!stop) { setPreviewErr(msg || "Couldn't decode this file."); setReady(true); }
      } finally {
        dec?.destroy();
      }
    })();
    return () => { stop = true; };
  }, [file]);

  const toggle = (f: Fmt) => setFormats((s) => { const n = new Set(s); n.has(f) ? n.delete(f) : n.add(f); return n; });

  // ---- server extraction ----
  function extractServer() {
    const form = new FormData();
    form.append("file", file);
    form.append("formats", [...formats].join(","));
    if (zones.length) form.append("zones", JSON.stringify(zones));
    create.mutate(form, { onSuccess: () => { onClose(); navigate({ to: "/" }); } });
  }

  // ---- in-browser extraction ----
  const [busy, setBusy] = useState(false);
  async function extractBrowser() {
    setBusy(true);
    setProgress({ pct: 0, stage: "starting" });
    try {
      const { extractInBrowser } = await import("@/clientside/clientOcr");
      const res = await extractInBrowser(file, { zones, fps: 4 }, (pct, stage) => setProgress({ pct, stage }));
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

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/60 p-4 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="my-6 w-full max-w-3xl rounded-2xl border border-border-strong bg-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-faint">New extraction</div>
            <div className="truncate text-sm font-medium">{file.name}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="size-4" /></Button>
        </div>

        <div className="p-5">
          <p className="mb-2 text-sm text-muted">Draw up to 2 subtitle zones over the frame (or leave the default band).</p>
          <div ref={stageRef} className="relative mx-auto aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
            {!ready && <div className="absolute inset-0 grid place-items-center"><Spinner className="size-6" /></div>}
            {previewErr ? (
              <div className="absolute inset-0 grid place-items-center px-6 text-center">
                <div>
                  <div className="text-sm text-muted">Preview unavailable in this browser.</div>
                  <div className="mt-1 text-xs text-faint">Set zones by ratio and extract — it still works.</div>
                  <div className="mt-2 break-words font-mono text-[10px] text-faint/70">{previewErr}</div>
                </div>
              </div>
            ) : (
              <canvas ref={canvasRef} className="absolute inset-0 size-full object-contain" />
            )}
            {ready && stageW > 0 && zones.map((z, i) => (
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
                    className="absolute -right-2 -top-2 z-20 grid size-5 place-items-center rounded-full bg-surface text-err shadow"><X className="size-3" /></button>
                </div>
              </Rnd>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="default" size="sm" disabled={zones.length >= 2} onClick={() => setZones((z) => [...z, { x: 0.3, y: 0.1, w: 0.4, h: 0.14 }])}><Plus className="size-3.5" /> Add zone</Button>
            <div className="flex items-center gap-2 text-sm">
              {FORMATS.map((f) => (
                <label key={f} className="flex items-center gap-1.5 text-muted"><input type="checkbox" className="size-4" checked={formats.has(f)} onChange={() => toggle(f)} /> {f.toUpperCase()}</label>
              ))}
            </div>
          </div>

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
