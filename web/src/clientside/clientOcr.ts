// 100% in-browser hardcoded-subtitle extraction (optional, privacy-preserving).
// Decode frames with WebCodecs (web-demuxer) → crop subtitle zones → OCR with
// PP-OCR on onnxruntime-web (WebGPU when available) → dedup → merge into cues.
// No upload. Best for short clips; WebGPU strongly recommended.
import { PaddleOcrService, getDefaultWebExecutionProviders } from "ppu-paddle-ocr/web";
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

// Cheap perceptual diff to skip OCR on unchanged bands.
function bandSignature(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const small = document.createElement("canvas");
  small.width = 32;
  small.height = 8;
  const ctx = small.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0, 32, 8);
  return ctx.getImageData(0, 0, 32, 8).data;
}

function similarSignature(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  const avg = diff / (a.length / 4) / 3;
  return avg < 8; // ~3% mean channel difference
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

function mergeCues(samples: Sample[], frameInterval: number): Cue[] {
  const cues: Cue[] = [];
  let cur: Cue | null = null;
  let counter = 0;
  for (const s of samples) {
    const t = s.text.trim();
    if (!t) {
      if (cur) {
        cur.end = s.t;
        cues.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur && levRatio(t, cur.text) >= 0.8) {
      cur.end = s.t;
      if (t.length > cur.text.length) {
        cur.text = t;
        cur.an = s.an;
      }
    } else {
      if (cur) cues.push(cur);
      cur = { id: `c-${counter++}`, start: s.t, end: s.t, text: t, an: s.an };
    }
  }
  if (cur) cues.push(cur);
  for (const c of cues) c.end += frameInterval;
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

  onProgress(6, "decoding");
  const dec = new FrameDecoder();
  await dec.init(file);
  const W = dec.width;
  const H = dec.height;
  const fps = opts.fps ?? 2;
  const frameInterval = 1 / fps;
  const total = Math.max(1, Math.floor((dec.duration || 0) * fps));

  const rects = (opts.zones && opts.zones.length ? opts.zones : [{ x: 0, y: 0.62, w: 1, h: 0.38 }]).map(
    (z) => pxRect(z, W, H),
  );
  const samples: Sample[][] = rects.map(() => []);
  const prevSig: (Uint8ClampedArray | null)[] = rects.map(() => null);
  const prevText: string[] = rects.map(() => "");

  const work = document.createElement("canvas");

  for (let i = 0; i < total; i++) {
    const t = i / fps;
    let bmp: ImageBitmap;
    try {
      bmp = await dec.frameAt(t);
    } catch {
      continue;
    }
    for (let zi = 0; zi < rects.length; zi++) {
      const r = rects[zi];
      work.width = r.w;
      work.height = r.h;
      const ctx = work.getContext("2d")!;
      ctx.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      const sig = bandSignature(work);

      let text: string;
      if (prevSig[zi] && similarSignature(sig, prevSig[zi]!)) {
        text = prevText[zi];
      } else {
        const res = await ocr.recognize(work, { flatten: true });
        text = (res?.text ?? "").trim();
        prevSig[zi] = sig;
        prevText[zi] = text;
      }
      samples[zi].push({ t, text, an: alignmentForZone(r, H) });
    }
    bmp.close();
    if (i % 5 === 0) onProgress(6 + Math.round((i / total) * 84), "ocr");
  }

  onProgress(94, "merging");
  const cues: Cue[] = [];
  for (const zoneSamples of samples) cues.push(...mergeCues(zoneSamples, frameInterval));
  cues.sort((a, b) => a.start - b.start);

  dec.destroy();
  onProgress(100, "done");
  return { cues, width: W, height: H };
}
