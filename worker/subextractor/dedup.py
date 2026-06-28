"""Frame change detection and merging OCR frames into timed subtitle cues.

Recall + precision techniques (per the design research):
  * Change detection on a high-contrast TEXT MASK (not raw SSIM) — reacts to text
    changes even when the background moves, and skips when text is unchanged.
  * Text-presence gate — skip OCR on bands with no text-like content (kills VLM
    hallucinations on empty frames, saves compute).
  * Post-merge filters — minimum persistence (frames) + duration, and a junk
    filter dropping pure-digit/punctuation flickers.
  * Majority vote — a cue's text is the most frequent reading across its frames.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

import cv2
import numpy as np
from rapidfuzz import fuzz

# Pure digits / punctuation up to 3 chars → almost always hallucination junk.
_JUNK_RE = re.compile(r"^[\W\d_]{1,3}$")
_HAS_LETTER = re.compile(r"[^\W\d_]")


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


@dataclass
class _Group:
    start: float
    end: float
    an: int
    texts: list[str] = field(default_factory=list)


def merge_into_cues(
    samples: list[tuple[float, str, int]],
    frame_interval: float,
    sim_threshold: float = 80.0,
    min_gap: float = 0.4,
    min_duration: float = 0.4,
    min_frames: int = 2,
    drop_junk: bool = True,
) -> list[Cue]:
    """Collapse per-frame (timestamp, text, alignment) samples into timed cues,
    then apply persistence/duration/junk filters and majority-vote the text."""
    groups: list[_Group] = []
    cur: _Group | None = None

    for ts, text, an in samples:
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
        else:
            if cur is not None:
                groups.append(cur)
            cur = _Group(start=ts, end=ts, an=an, texts=[t])
    if cur is not None:
        groups.append(cur)

    cues: list[Cue] = []
    for g in groups:
        end = g.end + frame_interval
        frames = len(g.texts)
        # Verification: a cue's text is the most frequent reading across frames.
        text = Counter(g.texts).most_common(1)[0][0]
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
