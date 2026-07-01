import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import type { Cue } from "./subtitles";

const REGION = "rgba(34,211,238,0.18)";
const REGION_SEL = "rgba(245,181,68,0.30)";
const REGION_DRAW = "rgba(34,211,238,0.28)";

interface Opts {
  media: HTMLMediaElement | null;
  container: HTMLDivElement | null;
  cues: Cue[];
  selectedId: string | null;
  onUpdate: (id: string, start: number, end: number) => void;
  onSelect: (id: string) => void;
  onCreate: (start: number, end: number) => void;
}

/** wavesurfer v7 bound to the page's <video> (shares audio + playback), with one
 * draggable region per cue. Regions are smart-synced to the cue list so drags
 * and time edits don't fight each other. */
export function useWaveform({ media, container, cues, selectedId, onUpdate, onSelect, onCreate }: Opts) {
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  // True while a region is being dragged/resized, so the cue-sync effect doesn't
  // write back mid-interaction and fight the drag.
  const draggingRef = useRef(false);
  // Ids of regions that mirror a real cue. A region whose id is absent here was
  // drawn by the user on empty waveform (drag-selection) → it becomes a new cue.
  const idsRef = useRef(new Set<string>());
  const pendingDrawRef = useRef(new Set<string>());
  // Keep latest callbacks/cues without re-creating wavesurfer.
  const cb = useRef({ onUpdate, onSelect, onCreate });
  cb.current = { onUpdate, onSelect, onCreate };

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

    // Drag across empty waveform to draw a new cue with exact in/out times.
    regions.enableDragSelection({ color: REGION_DRAW });

    // A freshly created region whose id isn't a known cue is a user-drawn one.
    // We wait for `region-updated` (drag end) to read its final bounds.
    regions.on("region-created", (r) => {
      if (!idsRef.current.has(r.id)) pendingDrawRef.current.add(r.id);
    });
    // `region-update` fires continuously during a drag/resize; `region-updated`
    // fires once when the interaction finishes. Commit only on the end event so
    // the cue list updates once, not on every animation frame.
    regions.on("region-update", () => { draggingRef.current = true; });
    regions.on("region-updated", (r) => {
      draggingRef.current = false;
      if (pendingDrawRef.current.has(r.id)) {
        // User drew this region: drop the temp region and create a real cue.
        // The sync effect re-adds it with the cue's id, color, and handlers.
        pendingDrawRef.current.delete(r.id);
        const { start, end } = r;
        r.remove();
        cb.current.onCreate(start, end);
        return;
      }
      cb.current.onUpdate(r.id, r.start, r.end);
    });
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
    // Mark these ids as cue-backed *before* addRegion fires `region-created`,
    // so programmatic regions aren't treated as user-drawn.
    idsRef.current = want;
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
    /** Scroll the waveform so `sec` is visible — used when the keyboard/table
     * moves the selection to a cue that's off-screen at the current zoom. */
    scrollToTime: (sec: number) => {
      const ws = wsRef.current;
      const dur = ws?.getDuration() || 0;
      if (ws && dur) ws.setScrollTime(sec);
    },
  };
}
