// Subtitle parse/serialize for the editor. The internal model is a flat list of
// cues; ASS is the richer master (carries \an alignment), SRT the plain form.
//
// Scope note: this round-trips our OCR output and standard SRT faithfully. Rich
// inbound ASS (animations, per-syllable karaoke) is reduced to text + \an.

export interface Cue {
  id: string;
  start: number; // seconds
  end: number; // seconds
  text: string; // newlines as \n
  an: number; // ASS alignment 1-9
  confidence?: number; // OCR mean line score 0..1 (undefined when unknown)
}

export interface ParsedSubs {
  cues: Cue[];
  width: number;
  height: number;
}

let counter = 0;
const nextId = () => `cue-${Date.now().toString(36)}-${counter++}`;

// ── timecode helpers ──────────────────────────────────────────────────────

export function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(r, 3)}`;
}

export function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const s = Math.floor((cs % 6_000) / 100);
  const r = cs % 100;
  return `${h}:${pad(m)}:${pad(s)}.${pad(r)}`;
}

// Editable HH:MM:SS.mmm display used in the cue table.
export function displayTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(r, 3)}`;
}

// Parse "HH:MM:SS.mmm" / "MM:SS.mmm" / "SS.mmm" back to seconds.
export function parseDisplayTime(v: string): number | null {
  const m = v.trim().match(/^(?:(\d+):)?(?:(\d{1,2}):)?(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const [, a, b, c, frac] = m;
  let h = 0;
  let min = 0;
  const sec = parseInt(c, 10);
  if (a !== undefined && b !== undefined) {
    h = parseInt(a, 10);
    min = parseInt(b, 10);
  } else if (a !== undefined) {
    min = parseInt(a, 10);
  }
  const ms = frac ? parseInt(frac.padEnd(3, "0"), 10) : 0;
  return h * 3600 + min * 60 + sec + ms / 1000;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

function parseSrtStamp(v: string): number {
  const m = v.trim().match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!m) return 0;
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4].padEnd(3, "0").slice(0, 3), 10) / 1000
  );
}

function parseAssStamp(v: string): number {
  const m = v.trim().match(/(\d+):(\d+):(\d+)[.,](\d+)/);
  if (!m) return 0;
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4].padEnd(2, "0").slice(0, 2), 10) / 100
  );
}

// ── parsing ───────────────────────────────────────────────────────────────

export function parseSRT(text: string): ParsedSubs {
  const blocks = text.replace(/\r/g, "").trim().split(/\n\n+/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const tcIndex = lines.findIndex((l) => l.includes("-->"));
    if (tcIndex === -1) continue;
    const [a, b] = lines[tcIndex].split("-->");
    cues.push({
      id: nextId(),
      start: parseSrtStamp(a),
      end: parseSrtStamp(b),
      text: lines.slice(tcIndex + 1).join("\n").trim(),
      an: 2,
    });
  }
  return { cues, width: 1280, height: 720 };
}

// Default field order for the [Events] section (the ASS spec order, and what
// this app emits). Used when a file has no `Format:` line to read.
const DEFAULT_EVENT_FIELDS = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];

/**
 * Parse ASS. Field positions in a Dialogue line are defined by the `Format:`
 * line inside `[Events]`, which is NOT always the canonical order — so we read
 * it and map field name → index (falling back to the default order if absent).
 *
 * Import limitation: rich ASS (animation, karaoke, per-event styling) is reduced
 * to text + \an alignment. Round-tripping this app's own output is exact.
 */
export function parseASS(text: string): ParsedSubs {
  const lines = text.replace(/\r/g, "").split("\n");
  let width = 1280;
  let height = 720;
  const cues: Cue[] = [];

  // Field-name → column index for Dialogue lines, from the [Events] Format line.
  let fields = DEFAULT_EVENT_FIELDS;
  let inEvents = false;

  for (const line of lines) {
    const resX = line.match(/^PlayResX:\s*(\d+)/i);
    if (resX) width = parseInt(resX[1], 10);
    const resY = line.match(/^PlayResY:\s*(\d+)/i);
    if (resY) height = parseInt(resY[1], 10);

    // Section headers (e.g. "[Events]", "[V4+ Styles]"): only the Events Format
    // line describes Dialogue columns.
    const section = line.match(/^\[([^\]]+)\]/);
    if (section) { inEvents = /events/i.test(section[1]); continue; }

    if (inEvents && /^Format:/i.test(line)) {
      fields = line.slice(line.indexOf(":") + 1).split(",").map((f) => f.trim());
      continue;
    }

    if (line.startsWith("Dialogue:")) {
      const idxOf = (name: string, fallback: number) => {
        const i = fields.findIndex((f) => f.toLowerCase() === name.toLowerCase());
        return i >= 0 ? i : fallback;
      };
      const startIdx = idxOf("Start", 1);
      const endIdx = idxOf("End", 2);
      const nameIdx = idxOf("Name", 4);
      const textIdx = idxOf("Text", fields.length - 1);

      const rest = line.slice("Dialogue:".length);
      // Text is always the last field and may itself contain commas, so split
      // only up to the text column, then re-join the remainder as the text.
      const parts = rest.split(",");
      if (parts.length <= textIdx) continue;
      const start = parseAssStamp(parts[startIdx]);
      const end = parseAssStamp(parts[endIdx]);
      // Name field optionally carries the OCR mean line score 0..1.
      const conf = parseFloat(parts[nameIdx]);
      const confidence = Number.isFinite(conf) && conf >= 0 && conf <= 1 ? conf : undefined;
      const rawText = parts.slice(textIdx).join(",");
      const anMatch = rawText.match(/\\an([1-9])/);
      const an = anMatch ? parseInt(anMatch[1], 10) : 2;
      const clean = rawText
        .replace(/\{[^}]*\}/g, "") // strip override tag blocks
        .replace(/\\N/gi, "\n")
        .replace(/\\h/gi, " ")
        .trim();
      cues.push({ id: nextId(), start, end, text: clean, an, confidence });
    }
  }
  return { cues, width, height };
}

export function parseSubtitles(text: string, kind: string): ParsedSubs {
  if (kind === "ass" || kind === "ssa" || /^\[Script Info\]/im.test(text)) {
    return parseASS(text);
  }
  return parseSRT(text);
}

// ── serializing ─────────────────────────────────────────────────────────────

export function toSRT(cues: Cue[]): string {
  return (
    cues
      .slice()
      .sort((a, b) => a.start - b.start)
      .map(
        (c, i) =>
          `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`,
      )
      .join("\n") + "\n"
  );
}

export function toVTT(cues: Cue[]): string {
  return (
    "WEBVTT\n\n" +
    cues
      .slice()
      .sort((a, b) => a.start - b.start)
      .map(
        (c, i) =>
          `${i + 1}\n${srtTime(c.start).replace(",", ".")} --> ${srtTime(c.end).replace(",", ".")}\n${c.text}\n`,
      )
      .join("\n")
  );
}

export function toASS(cues: Cue[], width: number, height: number): string {
  const fontsize = Math.max(16, Math.round(height * 0.05));
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontsize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = cues
    .slice()
    .sort((a, b) => a.start - b.start)
    .map((c) => {
      const tag = c.an && c.an !== 2 ? `{\\an${c.an}}` : "";
      const text = c.text.replace(/\n/g, "\\N");
      return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${tag}${text}`;
    })
    .join("\n");
  return header + events + "\n";
}

export function newCue(start: number, end: number): Cue {
  return { id: nextId(), start, end, text: "", an: 2 };
}
