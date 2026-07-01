// 100% in-browser hardcoded-subtitle extraction (optional, privacy-preserving).
// Decode frames with WebCodecs (web-demuxer) → crop subtitle zones → OCR with
// PP-OCR on onnxruntime-web (WebGPU when available) → dedup → merge into cues.
// No upload. Best for short clips; WebGPU strongly recommended.
import { PaddleOcrService, DetectionService, getDefaultWebExecutionProviders } from "ppu-paddle-ocr/web";
import * as ort from "onnxruntime-web";
import { env as ortEnv } from "onnxruntime-web";
import type { Zone } from "../api/types";

// Load onnxruntime-web's WASM runtime SAME-ORIGIN (served at /ort/ by the Vite
// plugin / nginx) instead of its default jsdelivr CDN — required under our CSP +
// cross-origin isolation, and makes in-browser OCR fully offline. ort is a single
// deduped instance shared with ppu-paddle-ocr, so setting this here applies to it.
ortEnv.wasm.wasmPaths = new URL("/ort/", location.href).href;

// PP-OCRv6 small models, self-hosted SAME-ORIGIN (served from /models by nginx /
// the dev server) instead of the library's GitHub default. Keeps in-browser OCR
// working offline + privacy-preserving, and — combined with the COOP/COEP
// cross-origin isolation the app sets — lets onnxruntime-web use its multi-
// threaded WASM backend (SharedArrayBuffer) at full speed.
const MODEL = {
  detection: new URL("/models/PP-OCRv6_small_det.ort", location.href).href,
  recognition: new URL("/models/PP-OCRv6_small_rec.ort", location.href).href,
  charactersDictionary: new URL("/models/ppocrv6_dict.txt", location.href).href,
};
import type { Cue } from "../editor/subtitles";
import { FrameDecoder } from "../editor/decodeFrame";

export function webGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

export interface ClientExtractOptions {
  fps?: number;
  zones?: Zone[];
  minConfidence?: number;
  /** When true, the subtitle zone is detected automatically (consumed later). */
  autoZone?: boolean;
}

export interface ClientExtractResult {
  cues: Cue[];
  width: number;
  height: number;
}

type Rect = { x: number; y: number; w: number; h: number };

function pxRect(z: Zone, w: number, h: number): Rect {
  const x = Math.max(0, Math.min(Math.round(z.x * w), w - 1));
  const y = Math.max(0, Math.min(Math.round(z.y * h), h - 1));
  return { x, y, w: Math.max(1, Math.round(z.w * w)), h: Math.max(1, Math.round(z.h * h)) };
}

function alignmentForZone(rect: Rect, h: number): number {
  const cy = rect.y + rect.h / 2;
  if (cy < h / 3) return 8; // top-center
  if (cy < (2 * h) / 3) return 5; // middle-center
  return 2; // bottom-center
}

// Change detection on a *text mask* rather than mean RGB: subtitles are bright
// (high-luma) text over a darker outline, a small fraction of the band's pixels.
// A mean-RGB diff is dominated by the (static) background and misses subtitle
// changes, so OCR gets skipped and a stale/garbage result sticks. Comparing a
// downscaled binary mask of bright pixels tracks the text shape instead.
let _maskCanvas: HTMLCanvasElement | null = null;
const MASK_W = 64;
const MASK_H = 16;

function textMask(src: HTMLCanvasElement): Uint8Array {
  _maskCanvas ??= document.createElement("canvas");
  _maskCanvas.width = MASK_W;
  _maskCanvas.height = MASK_H;
  const ctx = _maskCanvas.getContext("2d")!;
  ctx.drawImage(src, 0, 0, MASK_W, MASK_H);
  const d = ctx.getImageData(0, 0, MASK_W, MASK_H).data;
  const mask = new Uint8Array(MASK_W * MASK_H);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    mask[p] = luma > 160 ? 1 : 0; // bright → likely text
  }
  return mask;
}

// Fraction of bright (text-like) cells — a cheap "is there text here?" gate so we
// skip OCR on empty frames (gaps between subtitles) without skipping frames that
// actually show text.
function maskDensity(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n / mask.length;
}

// --- DBNet detection gate --------------------------------------------------
// Mirror of the server's DBNet presence gate + auto-zone (worker/subextractor
// /pipeline.py). Instead of the bright-pixel mask heuristic (which misses faint
// / short cues), a proper text detector decides "is there >=1 text box here?".
// We build one dedicated onnxruntime-web session for the det model (the
// PaddleOcrService keeps its own detection session private, so it can't be
// reused) and run it standalone via DetectionService.
//
// Perf: the det model self-resizes its input to `maxSideLength` (longest side).
// We cap that low (DET_MAX_SIDE) so per-frame detection on the already-small
// subtitle crop stays cheap on WASM/WebGPU. The gate runs on every sampled
// frame (the whole point is to catch cues the mask misses); the change-
// detection below still decides whether to *re-OCR* an unchanged reading.
const DET_MAX_SIDE = 640; // longest-side cap for the gate crop (fast)
const DET_AUTOZONE_MAX_SIDE = 960; // full-frame auto-zone pass wants more detail

interface DetHandle {
  service: DetectionService;
  session: ort.InferenceSession;
}

async function buildDetector(maxSideLength: number): Promise<DetHandle | null> {
  try {
    const providers = await getDefaultWebExecutionProviders();
    const buf = await fetch(MODEL.detection).then((r) => {
      if (!r.ok) throw new Error(`det model ${r.status}`);
      return r.arrayBuffer();
    });
    const session = await ort.InferenceSession.create(new Uint8Array(buf), {
      executionProviders: providers,
      graphOptimizationLevel: "all",
    });
    return { service: new DetectionService(session, { maxSideLength }), session };
  } catch (e) {
    console.warn("[clientOcr] DBNet detector unavailable, falling back to mask gate:", e);
    return null;
  }
}

// Presence gate: text present iff the detector finds >=1 box (server parity:
// `detector.detect(crop) >= 1`).
async function detectHasText(detector: DetectionService, canvas: HTMLCanvasElement): Promise<boolean> {
  const boxes = await detector.run(canvas);
  return boxes.length >= 1;
}

// Auto-zone: run the detector on a sparse set of FULL frames, collect every
// box's normalized (y-center, height, x-extent), 1D-cluster on y-centers, and
// emit up to 2 subtitle band(s). Port of pipeline.py:auto_detect_zones. Returns
// null when nothing solid recurs (caller falls back to the default bottom band).
type DetBox = { yc: number; bh: number; x1: number; x2: number };

async function autoDetectZones(
  file: File,
  duration: number,
  detector: DetectionService,
): Promise<Zone[] | null> {
  // Sparse sampling: ~one frame every 3s, at least a few, capped so this stays
  // a quick pre-pass.
  const dur = Math.max(1, duration);
  const nSamples = Math.floor(Math.min(15, Math.max(4, dur / 3)));
  const sampleFps = nSamples / dur;

  // Auto-zone needs its own decode pass over full frames. Use a fresh decoder
  // so the main extraction decode isn't consumed.
  const scan = new FrameDecoder();
  await scan.load(file);
  const boxes: DetBox[] = [];
  let nFrames = 0;
  const work = document.createElement("canvas");
  try {
    for await (const { bitmap } of scan.sampleFrames(sampleFps)) {
      nFrames++;
      const W = bitmap.width, H = bitmap.height;
      if (W > 0 && H > 0) {
        work.width = W;
        work.height = H;
        work.getContext("2d")!.drawImage(bitmap, 0, 0);
        for (const b of await detector.run(work)) {
          const x1 = b.x, y1 = b.y, x2 = b.x + b.width, y2 = b.y + b.height;
          if (x2 <= x1 || y2 <= y1) continue;
          boxes.push({ yc: (y1 + y2) / 2 / H, bh: (y2 - y1) / H, x1: x1 / W, x2: x2 / W });
        }
      }
      bitmap.close();
      if (nFrames >= nSamples + 2) break; // guard against fps rounding overshoot
    }
  } finally {
    scan.destroy();
  }
  if (nFrames === 0 || boxes.length === 0) return null;

  // 1D clustering on y-centers: sort, greedily group neighbors within a
  // tolerance derived from the median box height.
  boxes.sort((a, b) => a.yc - b.yc);
  const heights = boxes.map((b) => b.bh).sort((a, b) => a - b);
  const medH = heights[heights.length >> 1] || 0.02;
  const tol = Math.max(medH, 0.02);

  const clusters: DetBox[][] = [];
  let cur: DetBox[] = [];
  let lastYc: number | null = null;
  for (const b of boxes) {
    if (lastYc === null || b.yc - lastYc <= tol) cur.push(b);
    else { clusters.push(cur); cur = [b]; }
    lastYc = b.yc;
  }
  if (cur.length) clusters.push(cur);

  // Keep clusters recurring across a reasonable fraction of sampled frames.
  const minSupport = Math.max(2, Math.round(0.2 * nFrames));
  let kept = clusters.filter((c) => c.length >= minSupport);
  if (!kept.length) return null;

  // Densest bands first; keep at most 2 (bottom band + optional top caption).
  kept.sort((a, b) => b.length - a.length);
  kept = kept.slice(0, 2);

  const zones: Zone[] = [];
  for (const c of kept) {
    const ycs = c.map((b) => b.yc);
    const bhs = c.map((b) => b.bh);
    const x1s = c.map((b) => b.x1);
    const x2s = c.map((b) => b.x2);
    const bandH = Math.max(...bhs);
    const yTop = Math.min(...ycs) - bandH / 2;
    const yBot = Math.max(...ycs) + bandH / 2;
    // Vertical padding so cropping doesn't clip ascenders/descenders or a
    // second wrapped line of the same subtitle.
    const padV = Math.max(bandH, 0.04);
    const y = Math.max(0, yTop - padV);
    const h = Math.min(1 - y, yBot - yTop + 2 * padV);
    // Horizontal extent with a small margin.
    const x = Math.max(0, Math.min(...x1s) - 0.02);
    const w = Math.min(1 - x, Math.max(...x2s) - Math.min(...x1s) + 0.04);
    if (h <= 0 || w <= 0) continue;
    zones.push({
      x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4),
    });
  }
  // Order top→bottom for stable zone indices.
  zones.sort((a, b) => a.y - b.y);
  return zones.length ? zones : null;
}

// Drop obvious OCR noise (single stray glyphs like "R", punctuation-only reads)
// so a bad transient frame can't seed a cue.
function isJunk(s: string): boolean {
  const c = s.replace(/\s/g, "");
  if (c.length < 2) return true;
  if (!/[\p{L}\p{N}]/u.test(c)) return true;
  // Short tokens with no vowel are almost always OCR noise on transition frames
  // (e.g. "YXK", "Δ"); real subtitle text has vowels.
  if (c.length <= 3 && !/[aeiouyàâäéèêëïîôöùûüœ0-9]/iu.test(c)) return true;
  return false;
}

function levRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const m = a.length;
  const n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - dp[n] / Math.max(m, n);
}

interface Sample {
  t: number;
  text: string;
  an: number;
}

// Group consecutive frames showing (roughly) the same text into one cue and
// majority-vote the text across the run, so a single misread frame can't define
// the cue. Up to 2 blank frames (OCR drops / fades) are bridged within a cue.
function mergeCues(samples: Sample[], frameInterval: number): Cue[] {
  const cues: Cue[] = [];
  let counter = 0;
  type Group = { start: number; end: number; an: number; votes: Map<string, number>; blanks: number };
  let group: Group | null = null;
  const winner = (votes: Map<string, number>): string => {
    let best = "", bc = 0;
    for (const [txt, c] of votes) if (c > bc || (c === bc && txt.length > best.length)) { best = txt; bc = c; }
    return best;
  };
  const flush = () => {
    if (!group) return;
    const text = winner(group.votes);
    if (text) cues.push({ id: `c-${counter++}`, start: group.start, end: group.end + frameInterval, text, an: group.an });
    group = null;
  };
  for (const s of samples) {
    const t = s.text.trim();
    if (!t) { if (group && ++group.blanks > 2) flush(); continue; }
    if (group && levRatio(t, winner(group.votes)) >= 0.6) {
      group.votes.set(t, (group.votes.get(t) ?? 0) + 1);
      group.end = s.t;
      group.blanks = 0;
      group.an = s.an;
    } else {
      flush();
      group = { start: s.t, end: s.t, an: s.an, votes: new Map([[t, 1]]), blanks: 0 };
    }
  }
  flush();
  return cues;
}

export async function extractInBrowser(
  file: File,
  opts: ClientExtractOptions,
  onProgress: (pct: number, stage: string) => void,
): Promise<ClientExtractResult> {
  onProgress(2, "loading model");
  const ocr = new PaddleOcrService({
    model: MODEL,
    processing: { engine: "canvas-native" },
    session: { executionProviders: await getDefaultWebExecutionProviders() },
  });
  await ocr.initialize();

  // DBNet presence gate (server parity). Built as a standalone det session on
  // the same model; null → fall back to the bright-pixel mask gate.
  const detector = await buildDetector(DET_MAX_SIDE);

  onProgress(6, "decoding");
  const dec = new FrameDecoder();
  const { duration } = await dec.load(file);
  const fps = opts.fps ?? 2;
  const frameInterval = 1 / fps;
  const total = Math.max(1, Math.floor((duration || 0) * fps));

  const defaultZone: Zone[] = [{ x: 0, y: 0.62, w: 1, h: 0.38 }];

  // Auto-zone: when enabled and no explicit zones were given, discover the
  // subtitle band(s) via DBNet on a sparse full-frame scan; on success use them,
  // else fall back to the default bottom band. Needs its own detector instance
  // sized for full frames (more detail than the per-frame crop gate).
  let zones: Zone[] | undefined = opts.zones && opts.zones.length ? opts.zones : undefined;
  if (opts.autoZone && !zones) {
    onProgress(4, "auto-zone");
    const azDetector = detector
      ? await buildDetector(DET_AUTOZONE_MAX_SIDE)
      : null;
    if (azDetector) {
      try {
        const detected = await autoDetectZones(file, duration || 0, azDetector.service);
        if (detected) {
          zones = detected;
          const bands = detected.map((z) => `y=${z.y.toFixed(2)}-${(z.y + z.h).toFixed(2)}`).join(", ");
          console.info(`[clientOcr] auto-zone: ${detected.length} band(s) at ${bands}`);
        } else {
          console.info("[clientOcr] auto-zone: fell back to default band");
        }
      } catch (e) {
        console.warn("[clientOcr] auto-zone failed, using default band:", e);
      } finally {
        try { await azDetector.session.release(); } catch { /* ignore */ }
      }
    }
  }

  let rects: Rect[] = [];
  let samples: Sample[][] = [];
  let W = 0, H = 0;
  const work = document.createElement("canvas");

  // Sequential decode → true per-time frames (not keyframe snaps), so OCR sees
  // the frames that actually carry subtitles.
  let processed = 0;
  for await (const { bitmap, time } of dec.sampleFrames(fps)) {
    if (W === 0) {
      W = bitmap.width;
      H = bitmap.height;
      rects = (zones && zones.length ? zones : defaultZone).map((z) => pxRect(z, W, H));
      samples = rects.map(() => []);
    }
    for (let zi = 0; zi < rects.length; zi++) {
      const r = rects[zi];
      work.width = r.w;
      work.height = r.h;
      const ctx = work.getContext("2d")!;
      ctx.drawImage(bitmap, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      // OCR every text-bearing frame so the consensus vote in mergeCues can
      // outvote single-frame misreads; skip frames with no text-like content.
      // Presence gate: the DBNet detector (recall win — catches faint/short
      // cues the mask misses) when available, else the bright-pixel mask.
      let text = "";
      const present = detector
        ? await detectHasText(detector.service, work)
        : maskDensity(textMask(work)) > 0.012;
      if (present) {
        const res = await ocr.recognize(work, { flatten: true });
        const raw = (res?.text ?? "").trim();
        text = isJunk(raw) ? "" : raw;
      }
      samples[zi].push({ t: time, text, an: alignmentForZone(r, H) });
    }
    bitmap.close();
    if (++processed % 5 === 0) onProgress(6 + Math.min(84, Math.round((processed / total) * 84)), "ocr");
  }

  onProgress(94, "merging");
  let cues: Cue[] = [];
  for (const zoneSamples of samples) cues.push(...mergeCues(zoneSamples, frameInterval));
  cues.sort((a, b) => a.start - b.start);

  // Drop permanent overlays (watermark / logo / station ID): a real subtitle
  // never spans most of the video. Server parity (pipeline.py): duration > 12s
  // AND > 0.5 * video-duration. Guards auto-zone + wide manual zones.
  if (duration > 0) {
    cues = cues.filter((c) => !((c.end - c.start) > 12 && (c.end - c.start) > 0.5 * duration));
  }

  dec.destroy();
  try { await detector?.session.release(); } catch { /* ignore */ }
  onProgress(100, "done");
  return { cues, width: W || 1280, height: H || 720 };
}
