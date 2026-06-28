import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FrameDecoder } from "@/editor/decodeFrame";
import { webCodecsAvailable } from "@/clientside/_caps";

export type PlayerMode = "loading" | "video" | "canvas" | "error";

/** A backend-agnostic media player. Plays a source either through a native
 * <video> (MP4/WebM — every browser) or, for containers the browser can't play
 * (MKV/HEVC), through a WebCodecs frame decoder drawing to a <canvas>. Both
 * backends expose the same play/pause/seek API so one set of controls + the
 * same keyboard shortcuts drive both. */
export interface SourcePlayer {
  mode: PlayerMode;
  error: string | null;
  dims: { width: number; height: number };
  duration: number;
  currentTime: number;
  playing: boolean;
  /** Native element when in "video" mode (e.g. for wavesurfer); null otherwise. */
  mediaEl: HTMLVideoElement | null;
  /** Source for the <video> tag (object URL for a File, or the passed URL). */
  videoSrc: string | undefined;
  attachVideo: (el: HTMLVideoElement | null) => void;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
  seekBy: (delta: number) => void;
}

const FALLBACK_DIMS = { width: 1280, height: 720 };

export function useSourcePlayer(source: { file?: File | null; url?: string | null }): SourcePlayer {
  const { file, url } = source;

  const [mode, setMode] = useState<PlayerMode>("loading");
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState(FALLBACK_DIMS);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mediaEl, setMediaEl] = useState<HTMLVideoElement | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ---- frames (WebCodecs) backend state ----
  const decoderRef = useRef<FrameDecoder | null>(null);
  const framesDurRef = useRef(0);
  const rafRef = useRef(0);
  const decodingRef = useRef(false);
  const playRef = useRef(false);            // current playing state (for the rAF loop)
  const timeRef = useRef(0);                // current time (for the rAF loop)
  const anchorRef = useRef({ t: 0, clock: 0 }); // play anchor: time + wall clock
  const modeRef = useRef<PlayerMode>("loading");
  modeRef.current = mode;

  const videoSrc = (file ? objectUrl : url) ?? undefined;

  // Object URL lifecycle for a File source.
  useEffect(() => {
    if (!file) { setObjectUrl(null); return; }
    const u = URL.createObjectURL(file);
    setObjectUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // Reset when the source changes — tear down any existing decoder + rAF first
  // so we don't leak the previous source's WebCodecs decoder.
  useEffect(() => {
    setMode("loading"); setError(null); setPlaying(false);
    setCurrentTime(0); setDuration(0); timeRef.current = 0; playRef.current = false;
    cancelAnimationFrame(rafRef.current);
    decoderRef.current?.destroy();
    decoderRef.current = null;
    framesDurRef.current = 0;
  }, [file, url]);

  const draw = useCallback((bmp: ImageBitmap) => {
    const cv = canvasRef.current;
    if (cv) { cv.width = bmp.width; cv.height = bmp.height; cv.getContext("2d")?.drawImage(bmp, 0, 0); }
    bmp.close?.();
  }, []);

  // Fall back to the WebCodecs canvas backend (native <video> couldn't play it).
  const startFramesBackend = useCallback(async () => {
    if (!webCodecsAvailable()) { setError("This browser has no WebCodecs video decoder."); setMode("error"); return; }
    try {
      // ZonePicker passes a File; the editor passes a URL — fetch it into a File.
      let srcFile = file ?? null;
      if (!srcFile && url) {
        const blob = await fetch(url, { credentials: "include" }).then((r) => r.blob());
        if (blob.type.includes("json") || blob.size < 1024) throw new Error("source video unavailable");
        srcFile = new File([blob], "video", { type: blob.type });
      }
      if (!srcFile) throw new Error("no source");
      const { FrameDecoder } = await import("@/editor/decodeFrame");
      // Destroy any decoder left over from a prior source before creating a new one.
      decoderRef.current?.destroy();
      decoderRef.current = null;
      const dec = new FrameDecoder();
      const bmp = await dec.init(srcFile);
      decoderRef.current = dec;
      framesDurRef.current = dec.duration || 0;
      setDims({ width: dec.width || FALLBACK_DIMS.width, height: dec.height || FALLBACK_DIMS.height });
      setDuration(dec.duration || 0);
      draw(bmp);
      setMode("canvas");
    } catch (e) {
      console.error("[player] WebCodecs decode failed:", e);
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      setError(msg); setMode("error");
    }
  }, [file, url, draw]);

  // Wire the native <video> element (probe + playback events).
  useEffect(() => {
    const el = mediaEl;
    if (!el) return;
    const onMeta = () => {
      if (el.videoWidth > 0) {
        setDims({ width: el.videoWidth, height: el.videoHeight });
        setDuration(el.duration || 0);
        setMode("video");
      }
    };
    const onTime = () => setCurrentTime(el.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onDur = () => setDuration(el.duration || 0);
    const onErr = () => {
      if (modeRef.current === "video") return;
      // Only fall back to WebCodecs for genuine decode/format failures — a
      // transient network error (MEDIA_ERR_NETWORK) shouldn't trip the fallback.
      const code = el.error?.code;
      if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE) {
        void startFramesBackend();
      } else if (code == null) {
        // No error info (some browsers fire a bare error event) — be permissive.
        void startFramesBackend();
      } else {
        setError("This video could not be loaded."); setMode("error");
      }
    };
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("durationchange", onDur);
    el.addEventListener("error", onErr);
    return () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("durationchange", onDur);
      el.removeEventListener("error", onErr);
    };
  }, [mediaEl, startFramesBackend]);

  // Smoothly sample the native element's time while playing (timeupdate is coarse).
  useEffect(() => {
    if (mode !== "video" || !playing || !mediaEl) return;
    let raf = 0;
    const tick = () => { setCurrentTime(mediaEl.currentTime); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode, playing, mediaEl]);

  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
    setMediaEl(el);
  }, []);

  // Cleanup the decoder on unmount.
  useEffect(() => () => { cancelAnimationFrame(rafRef.current); decoderRef.current?.destroy(); decoderRef.current = null; }, []);

  // ---- frames playback loop (seek-decode driven; ~as fast as decode allows) ----
  const decodeAt = useCallback(async (t: number) => {
    const dec = decoderRef.current;
    if (!dec || decodingRef.current) return;
    decodingRef.current = true;
    try { draw(await dec.frameAt(t)); } catch { /* keep last frame */ }
    finally { decodingRef.current = false; }
  }, [draw]);

  const framesLoop = useCallback(() => {
    if (!playRef.current) return;
    const now = performance.now();
    const t = anchorRef.current.t + (now - anchorRef.current.clock) / 1000;
    const dur = framesDurRef.current;
    if (dur && t >= dur) {
      timeRef.current = dur; setCurrentTime(dur);
      playRef.current = false; setPlaying(false);
      void decodeAt(dur);
      return;
    }
    timeRef.current = t; setCurrentTime(t);
    void decodeAt(t);
    rafRef.current = requestAnimationFrame(framesLoop);
  }, [decodeAt]);

  // ---- uniform controls (stable identities so hotkeys don't rebind) ----
  const play = useCallback(() => {
    if (modeRef.current === "video") { videoElRef.current?.play().catch(() => {}); return; }
    if (modeRef.current === "canvas") {
      playRef.current = true; setPlaying(true);
      anchorRef.current = { t: timeRef.current, clock: performance.now() };
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(framesLoop);
    }
  }, [framesLoop]);

  const pause = useCallback(() => {
    if (modeRef.current === "video") { videoElRef.current?.pause(); return; }
    playRef.current = false; setPlaying(false);
    cancelAnimationFrame(rafRef.current);
  }, []);

  const toggle = useCallback(() => {
    if (modeRef.current === "canvas") { playRef.current ? pause() : play(); return; }
    const el = videoElRef.current;
    if (el) el.paused ? play() : pause();
  }, [play, pause]);

  const seek = useCallback((t: number) => {
    const clamp = (x: number) => Math.max(0, x);
    if (modeRef.current === "video") {
      const el = videoElRef.current; if (!el) return;
      el.currentTime = clamp(Math.min(t, el.duration || t)); setCurrentTime(el.currentTime);
      return;
    }
    if (modeRef.current === "canvas") {
      const dur = framesDurRef.current;
      const nt = Math.min(clamp(t), dur || clamp(t));
      timeRef.current = nt; setCurrentTime(nt);
      anchorRef.current = { t: nt, clock: performance.now() }; // keep play anchor consistent
      void decodeAt(nt);
    }
  }, [decodeAt]);

  const seekBy = useCallback((delta: number) => seek(timeRef.current + delta), [seek]);

  // Keep timeRef in sync for the native path (so seekBy works there too).
  useEffect(() => { timeRef.current = currentTime; }, [currentTime]);

  return useMemo<SourcePlayer>(() => ({
    mode, error, dims, duration, currentTime, playing, mediaEl, videoSrc,
    attachVideo, canvasRef, play, pause, toggle, seek, seekBy,
  }), [mode, error, dims, duration, currentTime, playing, mediaEl, videoSrc, attachVideo, play, pause, toggle, seek, seekBy]);
}
