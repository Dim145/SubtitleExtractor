// In-browser frame decoding for the subtitle-area selector. The plain <video>
// element can't play MKV/HEVC, so for those we decode a frame with WebCodecs
// (hardware decoder via the OS) fed by the web-demuxer WASM demuxer, and draw it
// to a canvas. Works for HEVC on platforms whose WebCodecs exposes it (e.g. macOS
// VideoToolbox in Safari/Chrome).
import { WebDemuxer } from "web-demuxer";

// The WASM demuxer binary (supports mkv/hevc/etc. demuxing), served SAME-ORIGIN
// by the web-demuxer-assets Vite plugin (see vite.config.ts). Must not be a CDN
// URL — that's CORS-blocked and fails offline / behind nginx.
//
// web-demuxer spawns its worker from a `data:`/`blob:` URL and resolves the wasm
// path against the worker's base. A `data:`/`blob:` URL has no usable base to
// resolve a root-relative path against, so a path like "/web-demuxer/..." can
// throw a module-resolution error in some browsers. Pass a fully-qualified
// absolute URL so resolution never depends on the worker base.
function wasmFileUrl(): string {
  return new URL("/web-demuxer/web-demuxer.wasm", location.href).href;
}

export function webCodecsAvailable(): boolean {
  return typeof window !== "undefined" && "VideoDecoder" in window;
}

// FrameDecoder lazily demuxes a File and decodes a frame at an arbitrary time.
export class FrameDecoder {
  private demuxer: WebDemuxer | null = null;
  width = 0;
  height = 0;
  duration = 0;

  async init(file: File): Promise<ImageBitmap> {
    const d = new WebDemuxer({ wasmFilePath: wasmFileUrl() });
    await d.load(file);
    this.demuxer = d;
    try {
      const info = await d.getMediaInfo();
      if (info?.duration) this.duration = Number(info.duration);
    } catch {
      /* duration optional */
    }
    return this.frameAt(this.duration ? Math.min(2, this.duration / 2) : 1);
  }

  async frameAt(time: number): Promise<ImageBitmap> {
    const d = this.demuxer;
    if (!d) throw new Error("decoder not initialized");
    const config = await d.getDecoderConfig("video");
    const chunk = await d.seek("video", Math.max(0, time));
    const frame: VideoFrame = await new Promise((resolve, reject) => {
      const dec = new VideoDecoder({
        output: (f) => resolve(f),
        error: (e) => reject(e),
      });
      dec.configure(config);
      dec.decode(chunk);
      dec.flush().catch(reject);
    });
    this.width = frame.displayWidth;
    this.height = frame.displayHeight;
    const bitmap = await createImageBitmap(frame);
    frame.close();
    return bitmap;
  }

  // Load without decoding (for sequential sampling). Returns duration for progress.
  async load(file: File): Promise<{ duration: number }> {
    const d = new WebDemuxer({ wasmFilePath: wasmFileUrl() });
    await d.load(file);
    this.demuxer = d;
    try {
      const info = await d.getMediaInfo();
      if (info?.duration) this.duration = Number(info.duration);
    } catch {
      /* duration optional */
    }
    return { duration: this.duration };
  }

  // Decode the video SEQUENTIALLY and yield ~`fps` frames/sec at their true
  // presentation time. Unlike frameAt() (seek → snaps to the nearest keyframe, so
  // most frames are never seen), this walks every packet through one VideoDecoder,
  // so OCR actually sees the frames that carry subtitles. Bounded memory via
  // backpressure; non-sampled frames are dropped immediately.
  async *sampleFrames(fps: number): AsyncGenerator<{ bitmap: ImageBitmap; time: number }> {
    const d = this.demuxer;
    if (!d) throw new Error("decoder not loaded");
    const config = await d.getDecoderConfig("video");
    const interval = 1 / fps;

    const queue: VideoFrame[] = [];
    let notify: (() => void) | null = null;
    const wake = () => { const n = notify; notify = null; n?.(); };
    let producerDone = false;
    let err: unknown = null;

    const decoder = new VideoDecoder({
      output: (f) => { queue.push(f); wake(); },
      error: (e) => { err = e; wake(); },
    });
    decoder.configure(config as VideoDecoderConfig);

    const reader = (d.read("video") as ReadableStream<EncodedVideoChunk>).getReader();
    const produce = async () => {
      try {
        for (;;) {
          while (queue.length + decoder.decodeQueueSize > 24) await new Promise((r) => setTimeout(r, 4));
          const { done, value } = await reader.read();
          if (done) break;
          decoder.decode(value);
        }
        await decoder.flush();
      } catch (e) {
        err = e;
      } finally {
        producerDone = true;
        wake();
      }
    };
    const producing = produce();

    try {
      let nextSample = 0;
      for (;;) {
        if (err) throw err;
        if (queue.length === 0) {
          if (producerDone) break;
          await new Promise<void>((r) => { notify = r; });
          continue;
        }
        const frame = queue.shift()!;
        const time = (frame.timestamp ?? 0) / 1e6;
        if (time + 1e-6 >= nextSample) {
          nextSample = Math.floor(time / interval) * interval + interval;
          let bitmap: ImageBitmap;
          try { bitmap = await createImageBitmap(frame); } finally { frame.close(); }
          if (this.width === 0) { this.width = bitmap.width; this.height = bitmap.height; }
          yield { bitmap, time };
        } else {
          frame.close();
        }
      }
      if (err) throw err;
    } finally {
      try { await reader.cancel(); } catch { /* ignore */ }
      for (const f of queue) { try { f.close(); } catch { /* ignore */ } }
      try { if (decoder.state !== "closed") decoder.close(); } catch { /* ignore */ }
      await producing.catch(() => {});
    }
  }

  destroy(): void {
    try {
      this.demuxer?.destroy();
    } catch {
      /* ignore */
    }
    this.demuxer = null;
  }
}
