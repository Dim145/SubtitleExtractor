"""Frame de-duplication and merging into timed subtitle cues.

Two techniques carry the timing accuracy (per the design research):
  * SSIM frame-skip: near-identical consecutive bands reuse the prior OCR result.
  * Levenshtein-ratio merge: consecutive frames with similar text collapse into
    one cue with a start/end, and tiny gaps between identical cues are bridged.
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np
from rapidfuzz import fuzz
from skimage.metrics import structural_similarity


@dataclass
class Cue:
    start: float
    end: float
    text: str
    an: int  # ASS alignment 1-9


def ssim_similar(gray_a: np.ndarray, gray_b: np.ndarray, threshold: float = 0.92) -> bool:
    """True when two grayscale bands are structurally near-identical."""
    if gray_a.shape != gray_b.shape:
        gray_b = cv2.resize(gray_b, (gray_a.shape[1], gray_a.shape[0]))
    if gray_a.size == 0:
        return False
    score = structural_similarity(gray_a, gray_b)
    return score >= threshold


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

    if cx < full_w / 3:
        col = 0  # left
    elif cx < 2 * full_w / 3:
        col = 1  # center
    else:
        col = 2  # right

    if cy < full_h / 3:
        base = 7  # top row: 7,8,9
    elif cy < 2 * full_h / 3:
        base = 4  # middle row: 4,5,6
    else:
        base = 1  # bottom row: 1,2,3
    return base + col


def merge_into_cues(
    samples: list[tuple[float, str, int]],
    frame_interval: float,
    sim_threshold: float = 80.0,
    min_gap: float = 0.4,
) -> list[Cue]:
    """Collapse per-frame (timestamp, text, alignment) samples into timed cues."""
    cues: list[Cue] = []
    cur: Cue | None = None

    for ts, text, an in samples:
        t = text.strip()
        if not t:
            if cur is not None:
                cur.end = ts
                cues.append(cur)
                cur = None
            continue
        if cur is not None and fuzz.ratio(t, cur.text) >= sim_threshold:
            cur.end = ts
            # Prefer the longer reading — usually the more complete OCR.
            if len(t) > len(cur.text):
                cur.text = t
                cur.an = an
        else:
            if cur is not None:
                cues.append(cur)
            cur = Cue(start=ts, end=ts, text=t, an=an)
    if cur is not None:
        cues.append(cur)

    # Show the last contributing frame for one interval.
    for c in cues:
        c.end += frame_interval

    # Bridge tiny gaps between consecutive near-identical cues.
    merged: list[Cue] = []
    for c in cues:
        if (
            merged
            and fuzz.ratio(c.text, merged[-1].text) >= sim_threshold
            and c.start - merged[-1].end <= min_gap
        ):
            merged[-1].end = c.end
        else:
            merged.append(c)
    return merged
