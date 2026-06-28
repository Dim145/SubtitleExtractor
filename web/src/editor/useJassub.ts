import { useEffect, useRef } from "react";
import JASSUB from "jassub";
import workerUrl from "jassub/dist/jassub-worker.js?url";
import wasmUrl from "jassub/dist/jassub-worker.wasm?url";

const EMPTY_ASS = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,36,&H00FFFFFF,&H00000000,&H64000000,0,0,1,2,1,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

// Renders ASS subtitles over a <video> via libass-wasm (JASSUB). Initialises
// once the video element exists; pushes new ASS content on every change.
export function useJassub(videoEl: HTMLVideoElement | null, content: string | null) {
  const renderer = useRef<JASSUB | null>(null);
  const latest = useRef<string>(EMPTY_ASS);

  useEffect(() => {
    latest.current = content || EMPTY_ASS;
    if (renderer.current && content) {
      try {
        renderer.current.setTrack(content);
      } catch (e) {
        console.error("JASSUB setTrack failed", e);
      }
    }
  }, [content]);

  useEffect(() => {
    if (!videoEl) return;
    let instance: JASSUB | null = null;
    let cancelled = false;
    try {
      instance = new JASSUB({
        video: videoEl,
        subContent: latest.current,
        workerUrl,
        wasmUrl,
      });
      if (cancelled) instance.destroy();
      else renderer.current = instance;
    } catch (e) {
      console.error("JASSUB init failed", e);
    }
    return () => {
      cancelled = true;
      try {
        instance?.destroy();
      } catch {
        /* ignore */
      }
      renderer.current = null;
    };
  }, [videoEl]);
}
