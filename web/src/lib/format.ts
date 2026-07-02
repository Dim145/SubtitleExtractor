// Build a friendly subtitle download name: "<video base>.<ext>" (e.g.
// "Movie.mkv" + "srt" → "Movie.srt"). Falls back to "subtitles" if unknown.
export function subtitleFilename(videoName: string | null | undefined, ext: string): string {
  const raw = (videoName || "").trim();
  const dot = raw.lastIndexOf(".");
  const base = (dot > 0 ? raw.slice(0, dot) : raw).trim() || "subtitles";
  return `${base}.${ext}`;
}

// Byte-size units (fr): octets, Ko, Mo, Go, To. 1 Ko = 1024 o.
const BYTE_UNITS = ["o", "Ko", "Mo", "Go", "To"] as const;
export type ByteUnit = (typeof BYTE_UNITS)[number];

/** Format a byte count in French units (comma decimal). 0 → "0 o". Bytes and
 * kilobytes show no decimals; Mo/Go/To show one. null/undefined → "—". */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n <= 0) return "0 o";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const decimals = i <= 1 ? 0 : 1;
  // fr formatting: comma decimal separator, no thousands grouping noise.
  const num = v.toLocaleString("fr-FR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${num} ${BYTE_UNITS[i]}`;
}

// Units offered by the admin quota inputs (a whole-number field + selector).
const UNIT_FACTOR: Record<"Mo" | "Go", number> = { Mo: 1024 ** 2, Go: 1024 ** 3 };

/** Convert a (value, unit) pair from a quota input to a byte count. Blank/invalid
 * value → null (caller treats null as "inherit"/"unlimited" per its own rules). */
export function bytesFromValueUnit(value: string | number | null | undefined, unit: "Mo" | "Go"): number | null {
  if (value == null || value === "") return null;
  const raw = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw * UNIT_FACTOR[unit]);
}

/** Split a byte count into a display (value, unit) pair for a quota input. Picks
 * Go when the size is a clean multiple of 1 Go (or ≥ 1 Go), else Mo. 0/null →
 * empty value (the input renders blank = « unlimited »/« default »). */
export function valueUnitFromBytes(bytes: number | null | undefined): { value: string; unit: "Mo" | "Go" } {
  if (bytes == null || bytes <= 0 || !Number.isFinite(bytes)) return { value: "", unit: "Go" };
  const gb = bytes / UNIT_FACTOR.Go;
  if (bytes % UNIT_FACTOR.Go === 0 || gb >= 1) {
    // Trim trailing zeros for a clean field value (e.g. "5", "1.5").
    return { value: String(Number(gb.toFixed(2))), unit: "Go" };
  }
  const mb = bytes / UNIT_FACTOR.Mo;
  return { value: String(Number(mb.toFixed(2))), unit: "Mo" };
}

export function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}
