import type { Zone } from "@/api/types";

// Remember the user's last subtitle-zone layout so they don't redraw it for
// every extraction. Persisted in localStorage; validated on read.
const KEY = "subext.zones.v1";

export const DEFAULT_ZONES: Zone[] = [{ x: 0.06, y: 0.7, w: 0.88, h: 0.22 }];

function isZone(z: unknown): z is Zone {
  if (!z || typeof z !== "object") return false;
  const r = z as Record<string, unknown>;
  return (["x", "y", "w", "h"] as const).every((k) => typeof r[k] === "number" && isFinite(r[k] as number) && (r[k] as number) >= 0 && (r[k] as number) <= 1);
}

export function loadZones(): Zone[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length >= 1 && arr.length <= 2 && arr.every(isZone)) {
        return arr.map((z) => ({ x: z.x, y: z.y, w: z.w, h: z.h }));
      }
    }
  } catch { /* ignore corrupt/unavailable storage */ }
  return DEFAULT_ZONES.map((z) => ({ ...z }));
}

export function saveZones(zones: Zone[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(zones)); } catch { /* storage may be disabled */ }
}
