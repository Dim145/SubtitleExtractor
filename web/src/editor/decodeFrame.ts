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

  destroy(): void {
    try {
      this.demuxer?.destroy();
    } catch {
      /* ignore */
    }
    this.demuxer = null;
  }
}
