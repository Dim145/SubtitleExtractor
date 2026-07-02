import { HardDrive, CircleCheck, TriangleAlert, CircleAlert } from "lucide-react";
import type { StorageInfo } from "@/api/types";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/cn";

// Quota state derived from the usage ratio. Colors come from the SEMANTIC tokens
// (never the cyan accent, which is reserved for interactive emphasis):
//   ok       (<80%)      → --ok green
//   near     (80–99%)    → --warn amber
//   over     (≥100%)     → --err red
type QuotaState = "ok" | "near" | "over";

const STATE: Record<QuotaState, { color: string; label: string; Icon: typeof CircleCheck; text: string }> = {
  ok:   { color: "var(--ok)",   label: "text-ok",   Icon: CircleCheck,   text: "Espace disponible" },
  near: { color: "var(--warn)", label: "text-warn", Icon: TriangleAlert, text: "Presque plein" },
  over: { color: "var(--err)",  label: "text-err",  Icon: CircleAlert,   text: "Quota atteint" },
};

function stateFor(pct: number): QuotaState {
  if (pct >= 100) return "over";
  if (pct >= 80) return "near";
  return "ok";
}

/** Storage-usage card for the Dashboard. Renders ONLY when quotas are enabled AND
 * a finite positive limit is set; the caller (Dashboard) guards this, but we also
 * bail defensively here. Shows a semantic, accessible usage meter. */
export function StorageQuota({ storage }: { storage: StorageInfo }) {
  const limit = storage.limitBytes;
  // Unlimited (null/0) or feature off → nothing to show.
  if (!storage.quotaEnabled || limit == null || limit <= 0) return null;

  const used = Math.max(0, storage.usedBytes);
  const ratio = used / limit;
  const pct = Math.round(ratio * 100);
  const fillPct = Math.max(0, Math.min(100, ratio * 100));
  const st = stateFor(pct);
  const { color, label, Icon, text } = STATE[st];

  const usedText = formatBytes(used);
  const limitText = formatBytes(limit);
  // Human, localized value for screen readers (e.g. "4,2 Go utilisés sur 5,0 Go, 84 %").
  const valueText = `${usedText} utilisés sur ${limitText}, ${pct} %`;

  return (
    <div className="animate-in mb-6 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted">
            <HardDrive className="size-4" aria-hidden="true" />
          </span>
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-faint">Stockage</span>
        </div>
        <div className="tabular-nums text-sm text-muted">
          <span className="font-medium text-text">{usedText}</span>
          <span className="text-faint"> / {limitText}</span>
        </div>
      </div>

      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={valueText}
        aria-label="Utilisation du stockage"
        className="mt-3 h-2 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="storage-fill h-full rounded-full"
          style={{ width: `${fillPct}%`, background: color }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className={cn("flex items-center gap-1.5 text-xs font-medium", label)}>
          <Icon className="size-3.5 shrink-0" aria-hidden="true" /> {text}
        </span>
        <span className="tabular-nums text-xs text-faint">{pct} %</span>
      </div>

      {(st === "near" || st === "over") && (
        <p className="mt-2 text-xs text-muted">Supprimez des vidéos pour libérer de l'espace.</p>
      )}
    </div>
  );
}
