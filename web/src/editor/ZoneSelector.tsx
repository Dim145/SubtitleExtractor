import { useCallback, useEffect, useRef, useState } from "react";
import { Rnd } from "react-rnd";
import type { Zone } from "../api/types";
import { Spinner } from "../components/ui";
import { subtitleFilename } from "../lib/format";
import { FrameDecoder, webCodecsAvailable } from "./decodeFrame";
import { toASS, toSRT, toVTT } from "./subtitles";

// Tiny check kept inline so the heavy OCR engine isn't pulled into the main
// bundle — extractInBrowser is dynamically imported only on demand.
function webGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

type Mode = "loading" | "video" | "canvas" | "unsupported";

const ZONE_COLORS = ["#f5b544", "#34d8c9"]; // amber, cyan
const DEFAULT_ZONE: Zone = { x: 0.06, y: 0.78, w: 0.88, h: 0.16 };
const TOP_ZONE: Zone = { x: 0.06, y: 0.06, w: 0.88, h: 0.16 };

export interface SubmitOpts {
  language: string;
  formats: string[];
  zones: Zone[];
}

export function ZoneSelector({
  file,
  onCancel,
  onSubmit,
  busy,
}: {
  file: File;
  onCancel: () => void;
  onSubmit: (opts: SubmitOpts) => void;
  busy?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("loading");
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [zones, setZones] = useState<Zone[]>([DEFAULT_ZONE]);
  const [language, setLanguage] = useState("");
  const [formats, setFormats] = useState<string[]>(["srt", "ass"]);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [playing, setPlaying] = useState(false);
  const [clientPct, setClientPct] = useState<number | null>(null);
  const [clientStage, setClientStage] = useState("");
  const [clientErr, setClientErr] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<FrameDecoder | null>(null);
  const seeking = useRef(false);
  const playingRef = useRef(false);

  // Probe the file: prefer a native <video>; fall back to WebCodecs for MKV/HEVC.
  useEffect(() => {
    let cancelled = false;
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    const probe = document.createElement("video");
    probe.preload = "metadata";
    probe.muted = true;
    probe.src = url;
    probe.onloadedmetadata = () => {
      if (cancelled) return;
      if (probe.videoWidth > 0) {
        setDims({ w: probe.videoWidth, h: probe.videoHeight });
        setDuration(probe.duration || 0);
        setMode("video");
      }
    };
    probe.onerror = async () => {
      if (cancelled) return;
      if (!webCodecsAvailable()) {
        setMode("unsupported");
        return;
      }
      try {
        const dec = new FrameDecoder();
        const bmp = await dec.init(file);
        if (cancelled) {
          dec.destroy();
          return;
        }
        decoderRef.current = dec;
        setDims({ w: dec.width, h: dec.height });
        setDuration(dec.duration || 0);
        setMode("canvas");
        drawBitmap(bmp);
      } catch (e) {
        console.error("WebCodecs decode failed", e);
        setMode("unsupported");
      }
    };
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
      decoderRef.current?.destroy();
      decoderRef.current = null;
    };
  }, [file]);

  // Track the displayed media box size for px<->normalized conversion. Because
  // the container's aspect-ratio matches the frame, the element IS the content
  // box (no letterbox offsets to correct).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setBox({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [mode]);

  function drawBitmap(bmp: ImageBitmap) {
    const c = canvasRef.current;
    if (!c) return;
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext("2d")?.drawImage(bmp, 0, 0);
    bmp.close();
  }

  const seek = useCallback(
    async (t: number) => {
      setTime(t);
      if (mode === "video" && videoRef.current) {
        videoRef.current.currentTime = t;
      } else if (mode === "canvas" && decoderRef.current && !seeking.current) {
        seeking.current = true;
        try {
          const bmp = await decoderRef.current.frameAt(t);
          drawBitmap(bmp);
        } catch (e) {
          console.error("seek decode failed", e);
        } finally {
          seeking.current = false;
        }
      }
    },
    [mode],
  );

  // Play/pause: native for the <video> path; a decode loop for the canvas path.
  function togglePlay() {
    if (mode === "video" && videoRef.current) {
      if (videoRef.current.paused) videoRef.current.play().catch(() => {});
      else videoRef.current.pause();
      return;
    }
    if (mode === "canvas") {
      if (playingRef.current) {
        playingRef.current = false;
        setPlaying(false);
      } else {
        playingRef.current = true;
        setPlaying(true);
        void runCanvasLoop();
      }
    }
  }

  async function runCanvasLoop() {
    const dec = decoderRef.current;
    if (!dec) return;
    let t = time;
    while (playingRef.current) {
      if (duration && t >= duration) break;
      try {
        const bmp = await dec.frameAt(t);
        drawBitmap(bmp);
      } catch {
        /* skip frame on decode hiccup */
      }
      setTime(t);
      t += 0.2; // ~5 fps preview (decode latency dominates)
      await new Promise((r) => setTimeout(r, 40));
    }
    playingRef.current = false;
    setPlaying(false);
  }

  useEffect(() => () => {
    playingRef.current = false;
  }, []);

  function updateZone(i: number, patch: Partial<Zone>) {
    setZones((prev) => prev.map((z, idx) => (idx === i ? { ...z, ...patch } : z)));
  }
  function addZone() {
    setZones((prev) => (prev.length >= 2 ? prev : [...prev, prev.length === 0 ? DEFAULT_ZONE : TOP_ZONE]));
  }
  function removeZone(i: number) {
    setZones((prev) => prev.filter((_, idx) => idx !== i));
  }
  function toggleFormat(f: string) {
    setFormats((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));
  }

  function downloadText(name: string, content: string) {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 100% in-browser extraction — no upload. Decodes + OCRs locally, downloads files.
  async function runBrowserExtract() {
    playingRef.current = false;
    setPlaying(false);
    setClientErr(null);
    setClientPct(0);
    try {
      // Lazy-load the OCR engine (ppu-paddle-ocr + onnxruntime-web) on first use.
      const { extractInBrowser } = await import("../clientside/clientOcr");
      const { cues, width, height } = await extractInBrowser(
        file,
        { fps: 2, zones },
        (p, stage) => {
          setClientPct(p);
          setClientStage(stage);
        },
      );
      if (formats.includes("srt")) downloadText(subtitleFilename(file.name, "srt"), toSRT(cues));
      if (formats.includes("ass")) downloadText(subtitleFilename(file.name, "ass"), toASS(cues, width, height));
      if (formats.includes("vtt")) downloadText(subtitleFilename(file.name, "vtt"), toVTT(cues));
      setClientStage(`done — ${cues.length} cues`);
    } catch (e) {
      console.error(e);
      setClientErr(e instanceof Error ? e.message : "Browser extraction failed");
    } finally {
      setTimeout(() => setClientPct(null), 1500);
    }
  }

  const ratio = dims.w && dims.h ? dims.w / dims.h : 16 / 9;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(5,7,11,0.7)",
        display: "grid",
        placeItems: "center",
        padding: 20,
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: "var(--bg-1)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          width: "min(900px, 96vw)",
          maxHeight: "92vh",
          overflow: "auto",
          padding: 20,
        }}
      >
        <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 16 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 16 }}>Subtitle area</h2>
            <p
              style={{
                margin: "2px 0 0",
                fontSize: 12,
                color: "var(--text-muted)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {file.name}
            </p>
          </div>
          <label style={{ marginLeft: "auto", display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Language (hint)</span>
            <input
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="fr, en, ja…"
              style={{ width: 160 }}
            />
          </label>
        </div>

        {mode === "loading" && (
          <div style={{ padding: 48, textAlign: "center" }}>
            <Spinner size={22} />
            <p style={{ color: "var(--text-muted)", marginTop: 10 }}>Decoding preview…</p>
          </div>
        )}

        {mode === "unsupported" && (
          <div
            style={{
              padding: 28,
              textAlign: "center",
              color: "var(--text-muted)",
              background: "var(--bg-2)",
              borderRadius: 10,
            }}
          >
            Your browser can't decode this file to preview it. You can still extract —
            the default bottom band will be used (or try Chrome/Safari on a machine
            with the right video decoder).
          </div>
        )}

        {(mode === "video" || mode === "canvas") && (
          <>
            <div
              ref={containerRef}
              style={{
                position: "relative",
                width: "100%",
                aspectRatio: String(ratio),
                maxHeight: "56vh",
                margin: "0 auto",
                background: "#000",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
              {mode === "video" ? (
                <video
                  ref={videoRef}
                  src={objectUrl ?? undefined}
                  muted
                  playsInline
                  onClick={togglePlay}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "pointer" }}
                />
              ) : (
                <canvas
                  ref={canvasRef}
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
                />
              )}

              {box.w > 0 &&
                zones.map((z, i) => (
                  <Rnd
                    key={i}
                    bounds="parent"
                    cancel=".zone-remove"
                    position={{ x: z.x * box.w, y: z.y * box.h }}
                    size={{ width: z.w * box.w, height: z.h * box.h }}
                    // The top-right resize handle is disabled so the remove (✕)
                    // button there is clickable instead of starting a resize.
                    enableResizing={{
                      top: true,
                      right: true,
                      bottom: true,
                      left: true,
                      topLeft: true,
                      topRight: false,
                      bottomLeft: true,
                      bottomRight: true,
                    }}
                    onDragStop={(_e, d) =>
                      updateZone(i, { x: d.x / box.w, y: d.y / box.h })
                    }
                    onResizeStop={(_e, _dir, ref, _delta, pos) =>
                      updateZone(i, {
                        w: ref.offsetWidth / box.w,
                        h: ref.offsetHeight / box.h,
                        x: pos.x / box.w,
                        y: pos.y / box.h,
                      })
                    }
                    style={{
                      border: `2px solid ${ZONE_COLORS[i]}`,
                      background: `${ZONE_COLORS[i]}22`,
                      boxSizing: "border-box",
                    }}
                  >
                    <button
                      className="zone-remove"
                      onMouseDown={(e) => e.stopPropagation()}
                      onTouchStart={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeZone(i);
                      }}
                      title="Remove zone"
                      aria-label="Remove zone"
                      style={{
                        position: "absolute",
                        top: -11,
                        right: -11,
                        width: 24,
                        height: 24,
                        borderRadius: "50%",
                        border: "none",
                        background: ZONE_COLORS[i],
                        color: "#10141c",
                        fontSize: 13,
                        cursor: "pointer",
                        lineHeight: "24px",
                        zIndex: 10,
                      }}
                    >
                      ✕
                    </button>
                  </Rnd>
                ))}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
              <button
                className="btn"
                onClick={togglePlay}
                aria-label={playing ? "Pause" : "Play"}
                style={{ padding: "6px 12px", minWidth: 64 }}
              >
                {playing ? "❚❚ Pause" : "▶ Play"}
              </button>
              <span className="mono" style={{ fontSize: 12, color: "var(--accent)", width: 56 }}>
                {time.toFixed(1)}s
              </span>
              <input
                type="range"
                min={0}
                max={duration || 60}
                step={0.5}
                value={time}
                onChange={(e) => seek(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <button
                className="btn btn-ghost"
                onClick={addZone}
                disabled={zones.length >= 2}
                style={{ color: "var(--accent-2)", whiteSpace: "nowrap" }}
              >
                + zone ({zones.length}/2)
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-faint)", margin: "8px 0 0" }}>
              Drag a box over the subtitles. Add a second zone for top-of-screen subs.
              Scrub to a frame that shows text.
            </p>
          </>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginTop: 18,
            paddingTop: 16,
            borderTop: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Formats</span>
            {["srt", "ass", "vtt"].map((f) => (
              <label key={f} style={{ display: "flex", gap: 6, fontSize: 13, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={formats.includes(f)}
                  onChange={() => toggleFormat(f)}
                  style={{ width: "auto" }}
                />
                {f.toUpperCase()}
              </label>
            ))}
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {clientErr ? (
              <span role="alert" style={{ fontSize: 12, color: "var(--err)" }}>
                {clientErr}
              </span>
            ) : clientPct !== null ? (
              <span className="mono" style={{ fontSize: 12, color: "var(--accent-2)" }}>
                {clientStage} {clientPct < 100 ? `${clientPct}%` : ""}
              </span>
            ) : null}
            <button className="btn" onClick={onCancel} disabled={busy || clientPct !== null}>
              Cancel
            </button>
            <button
              className="btn"
              onClick={runBrowserExtract}
              disabled={busy || clientPct !== null || formats.length === 0}
              title={
                webGpuAvailable()
                  ? "Extract locally in your browser (no upload)"
                  : "WebGPU not detected — browser extraction will be slow"
              }
            >
              {clientPct !== null ? "Extracting…" : "Extract in browser"}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || clientPct !== null || formats.length === 0}
              onClick={() => onSubmit({ language, formats, zones })}
            >
              {busy ? "Uploading…" : "Process video"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
