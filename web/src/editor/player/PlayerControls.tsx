import { Play, Pause, SkipBack, SkipForward } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SourcePlayer } from "./useSourcePlayer";

/** Compact m:ss(.s) clock for the transport. */
function clock(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Backend-agnostic transport: play/pause, skip ±5s, and a seekable progress
 * bar with elapsed / total time. Drives any SourcePlayer (native or WebCodecs). */
export function PlayerControls({ player, className }: { player: SourcePlayer; className?: string }) {
  const { playing, currentTime, duration, toggle, seek, seekBy } = player;
  const max = duration || 0;
  const pct = max ? Math.min(100, (currentTime / max) * 100) : 0;

  return (
    <div className={cn("flex items-center gap-2.5 px-3 py-2", className)}>
      <button
        type="button" onClick={() => seekBy(-5)} title="Back 5s (←)"
        className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
      ><SkipBack className="size-4" /></button>

      <button
        type="button" onClick={toggle} title="Play / Pause (Space)"
        className="grid size-9 place-items-center rounded-full bg-accent text-accent-foreground shadow transition hover:brightness-110"
      >{playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}</button>

      <button
        type="button" onClick={() => seekBy(5)} title="Forward 5s (→)"
        className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
      ><SkipForward className="size-4" /></button>

      <span className="ml-1 font-mono text-[11px] tabular-nums text-muted">{clock(currentTime)}</span>

      <input
        type="range" min={0} max={max} step={0.01} value={Math.min(currentTime, max)}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Seek"
        className="player-seek h-1.5 flex-1 cursor-pointer appearance-none rounded-full outline-none"
        style={{ background: `linear-gradient(to right, var(--accent) ${pct}%, var(--border-strong) ${pct}%)` }}
      />

      <span className="font-mono text-[11px] tabular-nums text-faint">{clock(max)}</span>
    </div>
  );
}
