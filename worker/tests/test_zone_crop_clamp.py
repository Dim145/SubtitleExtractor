"""Unit tests for zone/crop clamping (pure geometry, no models/video)."""
from __future__ import annotations

from subextractor.pipeline import _resolve_zones
from subextractor.video import parse_crop

W, H = 1920, 1080


def _inside(x, y, w, h, width=W, height=H):
    return 0 <= x < width and 0 <= y < height and w >= 1 and h >= 1 and x + w <= width and y + h <= height


def test_resolve_zones_default_band():
    rects = _resolve_zones(None, W, H)
    assert len(rects) == 1
    x, y, w, h = rects[0]
    assert _inside(x, y, w, h)
    # Default band sits in the lower part of the frame.
    assert y > H // 2


def test_resolve_zones_normalized_rect():
    zones = [{"x": 0.1, "y": 0.8, "w": 0.8, "h": 0.15}]
    (x, y, w, h), = _resolve_zones(zones, W, H)
    assert _inside(x, y, w, h)


def test_resolve_zones_overflow_is_clamped():
    # A zone that runs past the right/bottom edges must be clamped to stay inside.
    zones = [{"x": 0.95, "y": 0.95, "w": 0.5, "h": 0.5}]
    (x, y, w, h), = _resolve_zones(zones, W, H)
    assert _inside(x, y, w, h)
    assert x <= W - 1 and y <= H - 1


def test_resolve_zones_origin_clamped_below_dimension():
    # Origin must never reach width/height (would leave a zero-width crop).
    zones = [{"x": 2.0, "y": 2.0, "w": 0.1, "h": 0.1}]
    (x, y, w, h), = _resolve_zones(zones, W, H)
    assert x <= W - 1 and y <= H - 1
    assert w >= 1 and h >= 1


def test_resolve_zones_caps_at_two():
    zones = [{"x": 0, "y": 0.1 * i, "w": 1, "h": 0.05} for i in range(5)]
    rects = _resolve_zones(zones, W, H)
    assert len(rects) == 2


def test_parse_crop_pixels_clamped():
    x, y, w, h = parse_crop("0:900:1920:200", W, H)
    assert _inside(x, y, w, h)


def test_parse_crop_origin_clamped_below_dimension():
    # x/y beyond the frame must clamp to width-1/height-1, leaving >=1px crop.
    x, y, w, h = parse_crop(f"{W + 50}:{H + 50}:100:100", W, H)
    assert x <= W - 1 and y <= H - 1
    assert w >= 1 and h >= 1
    assert _inside(x, y, w, h)


def test_parse_crop_invalid_falls_back_to_default():
    x, y, w, h = parse_crop("garbage", W, H)
    assert _inside(x, y, w, h)
    assert y > H // 2  # default lower band
