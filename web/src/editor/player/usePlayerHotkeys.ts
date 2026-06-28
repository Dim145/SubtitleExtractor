import { useEffect } from "react";
import type { SourcePlayer } from "./useSourcePlayer";

/** Uniform keyboard transport, shared by every page that embeds the player:
 *   Space / K   play-pause
 *   ← / J       back 5s   (Shift → 1s)
 *   → / L       fwd 5s    (Shift → 1s)
 *   Home        jump to start
 * Ignored while typing in a field. Takes the player's stable methods so it
 * never rebinds on time updates. */
export function usePlayerHotkeys(
  { toggle, seek, seekBy }: Pick<SourcePlayer, "toggle" | "seek" | "seekBy">,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
      switch (e.key) {
        case " ": case "k": case "K": e.preventDefault(); toggle(); break;
        case "ArrowLeft": case "j": case "J": e.preventDefault(); seekBy(e.shiftKey ? -1 : -5); break;
        case "ArrowRight": case "l": case "L": e.preventDefault(); seekBy(e.shiftKey ? 1 : 5); break;
        case "Home": e.preventDefault(); seek(0); break;
        default: break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, toggle, seek, seekBy]);
}
