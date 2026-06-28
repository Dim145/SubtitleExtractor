// Lightweight capability probes (no heavy imports) so the dashboard/modal can
// gate on them without pulling in web-demuxer or onnxruntime until needed.
export function webCodecsAvailable(): boolean {
  return typeof window !== "undefined" && "VideoDecoder" in window;
}

export function webGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}
