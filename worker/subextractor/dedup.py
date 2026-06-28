"""Frame change detection and merging OCR frames into timed subtitle cues.

Recall + precision techniques (per the design research):
  * Change detection on a high-contrast TEXT MASK (not raw SSIM) — reacts to text
    changes even when the background moves, and skips when text is unchanged.
  * Text-presence gate — skip OCR on bands with no text-like content (kills VLM
    hallucinations on empty frames, saves compute).
  * Post-merge filters — minimum persistence (frames) + duration, and a junk
    filter dropping pure-digit/punctuation flickers.
  * Character-level consensus — a cue's text is voted character-by-character
    across its frames, weighted by OCR confidence, so single-character misreads
    that no single frame got entirely right are repaired.
"""
from __future__ import annotations

import re
import threading
from collections import Counter
from dataclasses import dataclass, field

import cv2
import numpy as np
from rapidfuzz import fuzz
from rapidfuzz.distance import Levenshtein

# Pure digits / punctuation up to 3 chars → almost always hallucination junk.
_JUNK_RE = re.compile(r"^[\W\d_]{1,3}$")
_HAS_LETTER = re.compile(r"[^\W\d_]")

# ReDoS hardening for admin-supplied substitution regexes. Two stdlib-only
# mitigations, no extra dependency (the `regex` module with a real timeout is
# unavailable here):
#   1. Cap the input each regex sees — catastrophic backtracking is super-linear
#      in input length, so a tight cap bounds the blast radius. Real cue text is
#      a line or two, well under the cap.
#   2. Run each sub() on a daemon worker thread with a wall-clock budget; if it
#      overruns we abandon it and leave the text unchanged for that rule.
# Residual limitation: CPython can't interrupt a thread stuck in C-level regex
# code, so an abandoned thread keeps burning ONE core until that sub() returns —
# but the job's main thread proceeds, so the job is never hung. Combined with the
# input cap and the admin-UI validation, this keeps a bad pattern from hanging
# the process indefinitely.
_SUB_MAX_INPUT = 4_000  # chars; real cues are a line or two
_SUB_TIMEOUT_SECS = 0.5


def _safe_sub(pattern: "re.Pattern", repl: str, text: str) -> str:
    """re.sub under a length cap + watchdog. Returns the original text if the
    substitution exceeds the time budget (likely catastrophic backtracking)."""
    if len(text) > _SUB_MAX_INPUT:
        text = text[:_SUB_MAX_INPUT]
    result: list[str] = []

    def _run() -> None:
        try:
            result.append(pattern.sub(repl, text))
        except Exception:  # noqa: BLE001
            pass

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(_SUB_TIMEOUT_SECS)
    if t.is_alive() or not result:
        # Timed out (thread can't be force-killed; it's daemon so it dies with the
        # process) or errored — leave the text unmodified for this rule.
        return text
    return result[0]


@dataclass
class Cue:
    start: float
    end: float
    text: str
    an: int  # ASS alignment 1-9
    frames: int = 1


def text_mask(gray: np.ndarray) -> np.ndarray:
    """Binary mask of bright (subtitle) pixels — isolates text from background."""
    return cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)[1]


def text_presence(gray: np.ndarray) -> float:
    """Edge-density score (0..1) as a cheap text-presence signal."""
    if gray.size == 0:
        return 0.0
    edges = cv2.Canny(gray, 80, 200)
    return float(np.count_nonzero(edges)) / edges.size


def mask_diff_ratio(a: np.ndarray, b: np.ndarray) -> float:
    """Fraction of differing pixels between two text masks (0..1)."""
    if a.shape != b.shape:
        b = cv2.resize(b, (a.shape[1], a.shape[0]))
    return float(np.count_nonzero(cv2.absdiff(a, b))) / max(1, a.size)


def is_junk(text: str) -> bool:
    """True for cue text that is empty / pure short digits-punctuation."""
    t = re.sub(r"\s+", "", text)
    if not t:
        return True
    if len(t) <= 1:
        # A single-glyph cue ("D", "1") is virtually always an OCR misfire.
        return True
    if _JUNK_RE.match(t):
        return True
    # No letters at all and very short → junk (e.g. "11", "0:0").
    return _HAS_LETTER.search(t) is None and len(t) <= 3


def alignment_from_bbox(
    bbox: tuple[float, float, float, float],
    full_w: int,
    full_h: int,
    crop_x: int,
    crop_y: int,
) -> int:
    """Map a text bbox (in cropped coords) to an ASS \\an alignment 1-9."""
    x1, y1, x2, y2 = bbox
    cx = crop_x + (x1 + x2) / 2
    cy = crop_y + (y1 + y2) / 2
    col = 0 if cx < full_w / 3 else (1 if cx < 2 * full_w / 3 else 2)
    base = 7 if cy < full_h / 3 else (4 if cy < 2 * full_h / 3 else 1)
    return base + col


def apply_substitution_rules(
    cues: list[Cue],
    rules: list[dict] | None,
    language: str | None = None,
) -> list[Cue]:
    """Apply admin-defined post-OCR substitution rules to each cue's text.

    Each rule is {find, replace, isRegex, applyTo}; applyTo is "all" or a language
    code. Literal rules use str.replace; regex rules use re.sub (invalid patterns
    are skipped defensively — the admin UI validates them up front). Mutates and
    returns the cues."""
    if not rules:
        return cues
    compiled: list[tuple[bool, object, str]] = []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        find = rule.get("find") or ""
        if not find:
            continue
        repl = rule.get("replace") or ""
        apply_to = rule.get("applyTo") or rule.get("apply_to") or "all"
        if apply_to and apply_to != "all" and (not language or apply_to != language):
            continue
        is_regex = bool(rule.get("isRegex") or rule.get("is_regex"))
        if is_regex:
            # Compile once (validates the pattern; invalid ones are skipped). The
            # per-cue sub runs under a watchdog (_safe_sub) to bound ReDoS impact.
            try:
                compiled.append((True, re.compile(find), repl))
            except re.error:
                continue
        else:
            compiled.append((False, find, repl))

    for c in cues:
        text = c.text
        for is_regex, pat, repl in compiled:
            text = _safe_sub(pat, repl, text) if is_regex else text.replace(pat, repl)
        c.text = text
    return cues


def _normalize(text: str) -> str:
    """Conservative post-OCR cleanup: trim each line, collapse runs of spaces,
    drop blank lines. Intentionally does NOT alter characters (no spell-fixing)."""
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def _align_to_anchor(anchor: str, t: str) -> list[str]:
    """For each index of `anchor`, the char of `t` aligned to it ('' if `t`
    deleted it). Chars `t` inserts beyond `anchor` are dropped so the output
    stays anchor-shaped (conservative: never invents characters)."""
    res = [""] * len(anchor)
    for tag, i1, i2, j1, j2 in Levenshtein.opcodes(anchor, t):
        if tag == "equal":
            for off in range(i2 - i1):
                res[i1 + off] = t[j1 + off]
        elif tag == "replace":
            for off in range(i2 - i1):
                dj = j1 + off
                res[i1 + off] = t[dj] if dj < j2 else ""
        # delete: anchor positions absent from t stay "" ; insert: ignored
    return res


def consensus_text(texts: list[str], weights: list[float] | None = None) -> str:
    """Confidence-weighted character-level consensus across repeated reads of the
    same subtitle line. Picks the most representative reading as an anchor, then
    votes per character (weighted by OCR confidence) to repair single-character
    errors that no single frame got entirely right. Falls back to the reading
    when frames agree."""
    texts = [t for t in texts if t]
    if not texts:
        return ""
    if weights is None or len(weights) != len(texts):
        weights = [1.0] * len(texts)
    weights = [max(float(w), 1e-6) for w in weights]
    if len(set(texts)) == 1:
        return texts[0]

    # Anchor = reading with the highest weighted similarity to all others (medoid).
    best_i, best_score = 0, -1.0
    for i, ti in enumerate(texts):
        score = sum(weights[j] * fuzz.ratio(ti, tj)
                    for j, tj in enumerate(texts) if j != i)
        if score > best_score:
            best_score, best_i = score, i
    anchor = texts[best_i]

    pos_votes: list[dict[str, float]] = [dict() for _ in range(len(anchor))]
    for t, w in zip(texts, weights):
        for k, ch in enumerate(_align_to_anchor(anchor, t)):
            pos_votes[k][ch] = pos_votes[k].get(ch, 0.0) + w

    out: list[str] = []
    for k, votes in enumerate(pos_votes):
        if not votes:
            out.append(anchor[k])
            continue
        # Highest weighted vote; ties are broken deterministically: prefer the
        # anchor's own character, then the lowest codepoint (stable, not dict order).
        best_ch = max(
            votes.items(),
            key=lambda kv: (kv[1], kv[0] == anchor[k], -ord(kv[0]) if kv[0] else 1),
        )[0]
        out.append(best_ch)
    return "".join(out)


@dataclass
class _Group:
    start: float
    end: float
    an: int
    texts: list[str] = field(default_factory=list)
    confs: list[float] = field(default_factory=list)


def merge_into_cues(
    samples: list[tuple[float, str, int, float]],
    frame_interval: float,
    sim_threshold: float = 80.0,
    min_gap: float = 0.4,
    min_duration: float = 0.4,
    min_frames: int = 2,
    drop_junk: bool = True,
    char_voting: bool = True,
) -> list[Cue]:
    """Collapse per-frame (timestamp, text, alignment, confidence) samples into
    timed cues, then apply persistence/duration/junk filters and consensus-vote
    the text. Samples may also be 3-tuples (no confidence) for compatibility."""
    groups: list[_Group] = []
    cur: _Group | None = None

    for sample in samples:
        ts, text, an = sample[0], sample[1], sample[2]
        conf = float(sample[3]) if len(sample) > 3 else 1.0
        t = text.strip()
        if not t:
            if cur is not None:
                cur.end = ts
                groups.append(cur)
                cur = None
            continue
        if cur is not None and fuzz.ratio(t, cur.texts[-1]) >= sim_threshold:
            cur.end = ts
            cur.texts.append(t)
            cur.confs.append(conf)
        else:
            if cur is not None:
                groups.append(cur)
            cur = _Group(start=ts, end=ts, an=an, texts=[t], confs=[conf])
    if cur is not None:
        groups.append(cur)

    cues: list[Cue] = []
    for g in groups:
        end = g.end + frame_interval
        frames = len(g.texts)
        if char_voting:
            text = consensus_text(g.texts, g.confs)
        else:
            text = Counter(g.texts).most_common(1)[0][0]
        text = _normalize(text)
        # Persistence + duration + junk filters.
        if frames < min_frames:
            continue
        if end - g.start < min_duration:
            continue
        if drop_junk and is_junk(text):
            continue
        cues.append(Cue(start=g.start, end=end, text=text, an=g.an, frames=frames))

    # Bridge tiny gaps between consecutive near-identical cues.
    merged: list[Cue] = []
    for c in cues:
        if (
            merged
            and fuzz.ratio(c.text, merged[-1].text) >= sim_threshold
            and c.start - merged[-1].end <= min_gap
        ):
            merged[-1].end = c.end
            merged[-1].frames += c.frames
        else:
            merged.append(c)
    return merged
