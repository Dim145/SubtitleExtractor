// Deterministic French OCR-residual normalizer (browser port of
// worker/subextractor/normalize_fr.py, same constants + rules + order).
//
// Two safe, wordlist-validated transforms on maximal letter runs of a cue:
//   1. Elision apostrophe — a run that is NOT a valid word but is an elision
//      prefix + a valid vowel-initial word gets its apostrophe restored. Handles
//      the missing apostrophe (`jai` -> `j'ai`, `quil` -> `qu'il`, `dun` ->
//      `d'un`) and the apostrophe misread as `i` (`dienfance` -> `d'enfance`).
//      Productive elisions (je/de/le/que) accept any vowel-word; restricted ones
//      (ne/ce/se/me/te) accept only a curated continuation set so we never emit
//      ungrammatical forms like `s'ours`.
//   2. Space split — a run that is NOT a valid word but segments into 2-3 valid
//      words (each >= 2 letters) gets the spaces inserted (`pastrop` -> `pas
//      trop`, `lointout` -> `loin tout`, `ceque` -> `ce que`). A valid word
//      (`attends`, `date`) is never touched.
//
// It never shortens text, never changes letters (except the elision `i` -> `'`),
// and never touches punctuation, casing or valid words. French-only: the caller
// gates on the job language.

const VOWELS = new Set("aeiouyàâäéèêëîïôöùûüh");
// Productive elisions: je/de/le/la/que elide before ANY vowel-initial word
// (j'ai, d'accord, l'ours, qu'il). Longest-first so "qu"/"jusqu" beat "j".
const ELISION_OPEN = ["jusqu", "lorsqu", "puisqu", "quoiqu", "qu", "j", "d", "l"];
// Restricted elisions: ne/ce/se/me/te only elide before specific pronouns/verbs,
// so accept ONLY a curated continuation (blocks e.g. "sours" -> "s'ours").
const ELISION_STRICT = ["n", "c", "s", "m", "t"];
const STRICT_CONT = new Set<string>([
  "est", "était", "étais", "étaient", "es", "ai", "a", "as", "ont", "avais",
  "avait", "avaient", "y", "en", "il", "ils", "elle", "elles", "on", "aime",
  "aimes", "aiment", "appelle", "appelles", "appellent", "agit", "agissait",
  "attends", "attend", "excuse", "endors", "enfuis", "habille", "occupe",
]);
const RUN = /[A-Za-zÀ-ÖØ-öø-ÿ]+/g;
const MIN_SPLIT_LEN = 5; // only attempt to split runs at least this long
const MIN_PIECE = 2; // each split piece must be at least this many letters

const FRENCH_LANGS = new Set(["fr", "fre", "fra", "french", "français", "francais"]);

export function isFrench(lang?: string): boolean {
  if (!lang) return false;
  return FRENCH_LANGS.has(lang.toLowerCase().split("-")[0]);
}

function capLike(src: string, out: string): string {
  return src[0] && src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase()
    ? out.slice(0, 1).toUpperCase() + out.slice(1)
    : out;
}

// Min-piece word-break of `low` into valid words (each >= MIN_PIECE). Returns the
// piece list (>= 2 pieces) or null. Prefers the fewest pieces.
function segment(low: string, words: Set<string>, maxpieces = 3): string[] | null {
  const n = low.length;
  let best: string[] | null = null;

  const rec = (start: number, pieces: string[]): void => {
    if (pieces.length >= maxpieces && start < n) return;
    if (start === n) {
      if (pieces.length >= 2 && (best === null || pieces.length < best.length)) {
        best = pieces.slice();
      }
      return;
    }
    for (let end = start + MIN_PIECE; end <= n; end++) {
      if (words.has(low.slice(start, end))) {
        pieces.push(low.slice(start, end));
        rec(end, pieces);
        pieces.pop();
      }
    }
  };

  rec(0, []);
  return best;
}

function fixRun(run: string, words: Set<string>): string {
  const low = run.toLowerCase();
  if (words.has(low)) return run; // valid word -> never touch
  // 1. elision. OPEN prefixes accept any vowel-word; STRICT prefixes accept
  // only a curated continuation (avoids ungrammatical s'ours etc.).
  const groups: Array<[string[], Set<string> | null]> = [
    [ELISION_OPEN, null],
    [ELISION_STRICT, STRICT_CONT],
  ];
  for (const [prefixes, gate] of groups) {
    for (const p of prefixes) {
      if (low.length > p.length && low.startsWith(p)) {
        const rest = low.slice(p.length);
        if (VOWELS.has(rest[0]) && words.has(rest) && (gate === null || gate.has(rest))) {
          return capLike(run, run.slice(0, p.length) + "'" + run.slice(p.length));
        }
        const rest2 = low.slice(p.length + 1);
        if (rest[0] === "i" && VOWELS.has(rest2[0]) && words.has(rest2)
            && (gate === null || gate.has(rest2))) {
          return capLike(run, run.slice(0, p.length) + "'" + run.slice(p.length + 1));
        }
      }
    }
  }
  // 2. space split
  if (low.length >= MIN_SPLIT_LEN) {
    const seg = segment(low, words);
    if (seg) {
      const out: string[] = [];
      let i = 0;
      for (const piece of seg) {
        out.push(run.slice(i, i + piece.length));
        i += piece.length;
      }
      return out.join(" ");
    }
  }
  return run;
}

// Apply the two transforms to every letter run in `text`.
export function normalizeLine(text: string, words: Set<string>): string {
  return text.replace(RUN, (m) => fixRun(m, words));
}
