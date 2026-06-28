import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import type { Cue } from "./subtitles";

const REGION = "rgba(34,211,238,0.18)";
const REGION_SEL = "rgba(245,181,68,0.30)";

interface Opts {
  media: HTMLMediaElement | null;
  container: HTMLDivElement | null;
  cues: Cue[];
  selectedId: string | null;
  onUpdate: (id: string, start: number, end: number) => void;
  onSelect: (id: string) => void;
}

/** wavesurfer v7 bound to the page's <video> (shares audio + playback), with one
 * draggable region per cue. Regions are smart-synced to the cue list so drags
 * and time edits don't fight each other. */
export function useWaveform({ media, container, cues, selectedId, onUpdate, onSelect }: Opts) {
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  // True while a region is being dragged/resized, so the cue-sync effect doesn't
  // write back mid-interaction and fight the drag.
  const draggingRef = useRef(false);
  // Keep latest callbacks/cues without re-creating wavesurfer.
  const cb = useRef({ onUpdate, onSelect });
  cb.current = { onUpdate, onSelect };

  useEffect(() => {
    if (!media || !container) return;
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container,
      media,
      height: 84,
      waveColor: "#3a465f",
      progressColor: "#5a6a85",
      cursorColor: "#f5b544",
      cursorWidth: 2,
      normalize: true,
      plugins: [regions, TimelinePlugin.create({ height: 16, style: { fontSize: "9px", color: "#5d6a85" } })],
    });
    wsRef.current = ws;
    regionsRef.current = regions;

    // `region-update` fires continuously during a drag/resize; `region-updated`
    // fires once when the interaction finishes. Commit only on the end event so
    // the cue list updates once, not on every animation frame.
    regions.on("region-update", () => { draggingRef.current = true; });
    regions.on("region-updated", (r) => { draggingRef.current = false; cb.current.onUpdate(r.id, r.start, r.end); });
    regions.on("region-clicked", (r, e) => { e.stopPropagation(); cb.current.onSelect(r.id); });

    return () => { ws.destroy(); wsRef.current = null; regionsRef.current = null; };
  }, [media, container]);

  // Smart-sync regions to the cue list (add new, remove gone, nudge changed).
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions) return;
    // Don't write region geometry back while the user is actively dragging —
    // it would fight the interaction and cause jitter.
    if (draggingRef.current) return;
    const existing = new Map(regions.getRegions().map((r) => [r.id, r]));
    const want = new Set(cues.map((c) => c.id));
    for (const [id, r] of existing) if (!want.has(id)) r.remove();
    for (const c of cues) {
      const r = existing.get(c.id);
      const color = c.id === selectedId ? REGION_SEL : REGION;
      if (!r) {
        regions.addRegion({ id: c.id, start: c.start, end: Math.max(c.end, c.start + 0.05), color, drag: true, resize: true });
      } else {
        if (Math.abs(r.start - c.start) > 0.005 || Math.abs(r.end - c.end) > 0.005) {
          r.setOptions({ start: c.start, end: c.end });
        }
        if ((r as unknown as { color: string }).color !== color) r.setOptions({ color });
      }
    }
  }, [cues, selectedId]);

  return {
    playPause: () => wsRef.current?.playPause(),
    seekTo: (sec: number) => {
      const ws = wsRef.current;
      const dur = ws?.getDuration() || 0;
      if (ws && dur) ws.seekTo(Math.min(0.999, sec / dur));
    },
    zoom: (pxPerSec: number) => wsRef.current?.zoom(pxPerSec),
  };
}
