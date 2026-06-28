import type { ReactNode, RefObject } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { PlayerControls } from "./PlayerControls";
import type { SourcePlayer } from "./useSourcePlayer";

/** The shared video surface: a 16:9 stage that shows either the native <video>
 * or the WebCodecs <canvas>, with an optional overlay (zones / captions) and the
 * uniform transport controls underneath. */
export function MediaStage({
  player, stageRef, overlay, controls = true, unavailable, className,
}: {
  player: SourcePlayer;
  stageRef?: RefObject<HTMLDivElement | null>;
  overlay?: ReactNode;
  controls?: boolean;
  /** Replaces the default "preview unavailable" message in error mode. */
  unavailable?: ReactNode;
  className?: string;
}) {
  const { mode, error, videoSrc, attachVideo, canvasRef } = player;

  return (
    <div className={className}>
      <div ref={stageRef} className="relative aspect-video w-full overflow-hidden bg-black">
        {/* canvas stays mounted so the WebCodecs path always has its ref */}
        <canvas ref={canvasRef} className="absolute inset-0 size-full object-contain" />
        {(mode === "loading" || mode === "video") && (
          <video
            ref={attachVideo}
            src={videoSrc}
            playsInline
            className="absolute inset-0 size-full object-contain"
            onLoadedData={(e) => { if (mode === "loading") { try { e.currentTarget.currentTime = Math.min(2, (e.currentTarget.duration || 4) / 2); } catch { /* best-effort */ } } }}
          />
        )}
        {mode === "loading" && <div className="absolute inset-0 grid place-items-center"><Spinner className="size-6" /></div>}
        {mode === "error" && (
          <div className="absolute inset-0 grid place-items-center bg-surface-2 px-6 text-center">
            {unavailable ?? (
              <div>
                <div className="text-sm font-medium">Preview unavailable in this browser.</div>
                <div className="mt-1 text-xs text-muted">You can still set zones / edit timings and extract.</div>
                {error && <div className="mt-2 break-words font-mono text-[10px] text-faint/70">{error}</div>}
              </div>
            )}
          </div>
        )}
        {overlay}
      </div>
      {controls && mode !== "error" && (
        <PlayerControls player={player} className={cn("border-t border-border bg-surface-2")} />
      )}
    </div>
  );
}
