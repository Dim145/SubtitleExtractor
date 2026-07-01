"""Unit tests for the permanent-overlay (watermark/logo) filter and the
horizontal-extent plumbing that feeds it. Pure: no models, no video.

The filter drops a cue only when it is BOTH long (absolute + fraction of clip)
AND narrow. A long cue that spans a near-full-frame width is a real subtitle /
song lyric and must be kept. When box geometry is unavailable (w_frac == 0.0
sentinel), the filter falls back to duration-only behavior.
"""
from __future__ import annotations

from subextractor.dedup import Cue, merge_into_cues
from subextractor.pipeline import (
    DEFAULT_PERMANENT_MIN_FRACTION,
    DEFAULT_PERMANENT_MIN_SECONDS,
    PERMANENT_MIN_WIDTH_FRAC,
    is_permanent_overlay,
)

CLIP = 20.0  # clip duration (s): long cues below exceed perm_secs AND perm_frac*CLIP


def _cue(start, end, w_frac=0.0, x_frac=0.0):
    return Cue(start=start, end=end, text="hello", an=2,
               x_frac=x_frac, w_frac=w_frac)


# --- is_permanent_overlay decision ------------------------------------------

def test_long_full_width_cue_is_kept():
    # 18s of a 20s clip, spanning ~90% of the width → real subtitle, KEEP.
    c = _cue(1.0, 19.0, w_frac=0.9, x_frac=0.05)
    assert (c.end - c.start) > DEFAULT_PERMANENT_MIN_SECONDS
    assert (c.end - c.start) > DEFAULT_PERMANENT_MIN_FRACTION * CLIP
    assert is_permanent_overlay(c, CLIP) is False


def test_long_narrow_cue_is_dropped():
    # Same long span but only ~15% of the width → corner watermark, DROP.
    c = _cue(1.0, 19.0, w_frac=0.15, x_frac=0.02)
    assert c.w_frac < PERMANENT_MIN_WIDTH_FRAC
    assert is_permanent_overlay(c, CLIP) is True


def test_short_cue_is_kept_regardless_of_width():
    # A normal short cue is never a permanent overlay, even if narrow.
    short_narrow = _cue(1.0, 3.0, w_frac=0.15)
    short_wide = _cue(1.0, 3.0, w_frac=0.9)
    assert is_permanent_overlay(short_narrow, CLIP) is False
    assert is_permanent_overlay(short_wide, CLIP) is False


def test_no_geometry_falls_back_to_duration_only():
    # w_frac == 0.0 sentinel (e.g. a VLM backend with no boxes): long cue is
    # treated as permanent (old behavior), short cue is kept.
    long_no_geom = _cue(1.0, 19.0, w_frac=0.0)
    short_no_geom = _cue(1.0, 3.0, w_frac=0.0)
    assert is_permanent_overlay(long_no_geom, CLIP) is True
    assert is_permanent_overlay(short_no_geom, CLIP) is False


def test_width_threshold_boundary():
    # Exactly at the threshold is NOT narrow (uses strict <), so it is kept.
    at_thr = _cue(1.0, 19.0, w_frac=PERMANENT_MIN_WIDTH_FRAC)
    just_below = _cue(1.0, 19.0, w_frac=PERMANENT_MIN_WIDTH_FRAC - 0.01)
    assert is_permanent_overlay(at_thr, CLIP) is False
    assert is_permanent_overlay(just_below, CLIP) is True


# --- merge_into_cues populates x_frac / w_frac -------------------------------

def _sample(ts, text, extent):
    # (timestamp, text, alignment, confidence, extent)
    return (ts, text, 2, 0.9, extent)


def test_merge_aggregates_horizontal_extent():
    # Two frames of the same cue with slightly different spans → the cue's extent
    # is the union: min x .. max (x + w).
    samples = [
        _sample(0.0, "bonjour", (0.10, 0.60)),  # 0.10 .. 0.70
        _sample(0.25, "bonjour", (0.05, 0.80)),  # 0.05 .. 0.85
        _sample(0.5, "", None),
    ]
    cues = merge_into_cues(samples, frame_interval=0.25, min_frames=2,
                           min_duration=0.1)
    assert len(cues) == 1
    c = cues[0]
    assert abs(c.x_frac - 0.05) < 1e-6
    assert abs(c.w_frac - (0.85 - 0.05)) < 1e-6


def test_merge_without_extent_leaves_sentinel():
    # 4-tuple samples (no extent element) → w_frac stays 0.0 (no geometry).
    samples = [
        (0.0, "bonjour", 2, 0.9),
        (0.25, "bonjour", 2, 0.9),
        (0.5, "", 2, 0.0),
    ]
    cues = merge_into_cues(samples, frame_interval=0.25, min_frames=2,
                           min_duration=0.1)
    assert len(cues) == 1
    assert cues[0].w_frac == 0.0
    assert cues[0].x_frac == 0.0


def test_merge_with_none_extent_leaves_sentinel():
    # 5-tuple samples whose extent is None (backend returned no boxes) → sentinel.
    samples = [
        _sample(0.0, "bonjour", None),
        _sample(0.25, "bonjour", None),
        _sample(0.5, "", None),
    ]
    cues = merge_into_cues(samples, frame_interval=0.25, min_frames=2,
                           min_duration=0.1)
    assert len(cues) == 1
    assert cues[0].w_frac == 0.0


def test_merge_partial_geometry_uses_available_frames():
    # Some frames have geometry, some don't → aggregate only the ones that do.
    samples = [
        _sample(0.0, "bonjour", None),
        _sample(0.25, "bonjour", (0.20, 0.55)),  # 0.20 .. 0.75
        _sample(0.5, "", None),
    ]
    cues = merge_into_cues(samples, frame_interval=0.25, min_frames=2,
                           min_duration=0.1)
    assert len(cues) == 1
    assert abs(cues[0].x_frac - 0.20) < 1e-6
    assert abs(cues[0].w_frac - 0.55) < 1e-6
