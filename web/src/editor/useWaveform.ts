import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import type { Cue } from "./subtitles";

interface Region {
  id: string;
  start: number;
  end: number;
  remove: () => void;
  setOptions: (o: { start?: number; end?: number }) => void;
}

// Binds a wavesurfer waveform to the video element and keeps one draggable /
// resizable region per cue, synced two-way with the cue model.
export function useWaveform(
  container: HTMLElement | null,
  videoEl: HTMLVideoElement | null,
  cues: Cue[],
  onUpdate: (id: string, start: number, end: number) => void,
  onSelect: (id: string) => void,
) {
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const map = useRef<Map<string, Region>>(new Map());
  const update = useRef(onUpdate);
  const select = useRef(onSelect);
  update.current = onUpdate;
  select.current = onSelect;

  useEffect(() => {
    if (!container || !videoEl) return;
    let ws: WaveSurfer | null = null;
    try {
      ws = WaveSurfer.create({
        container,
        media: videoEl,
        height: 84,
        waveColor: "#3a4252",
        progressColor: "#586074",
        cursorColor: "#f5b544",
        cursorWidth: 2,
        normalize: true,
      });
      const regions = ws.registerPlugin(RegionsPlugin.create());
      regionsRef.current = regions;
      regions.on("region-updated", (r: Region) => update.current(r.id, r.start, r.end));
      regions.on("region-clicked", (r: Region, e: MouseEvent) => {
        e.stopPropagation();
        select.current(r.id);
      });
    } catch (e) {
      console.error("wavesurfer init failed", e);
    }
    return () => {
      try {
        ws?.destroy();
      } catch {
        /* ignore */
      }
      regionsRef.current = null;
      map.current.clear();
    };
  }, [container, videoEl]);

  // Reconcile regions with the cue list (add / move / remove).
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions) return;
    const seen = new Set<string>();
    for (const c of cues) {
      seen.add(c.id);
      const existing = map.current.get(c.id);
      if (existing) {
        if (Math.abs(existing.start - c.start) > 0.02 || Math.abs(existing.end - c.end) > 0.02) {
          try {
            existing.setOptions({ start: c.start, end: c.end });
          } catch {
            /* ignore */
          }
        }
      } else {
        const r = regions.addRegion({
          id: c.id,
          start: c.start,
          end: c.end,
          drag: true,
          resize: true,
          color: "rgba(52,216,201,0.16)",
        }) as unknown as Region;
        map.current.set(c.id, r);
      }
    }
    for (const [id, r] of map.current) {
      if (!seen.has(id)) {
        try {
          r.remove();
        } catch {
          /* ignore */
        }
        map.current.delete(id);
      }
    }
  }, [cues]);
}
