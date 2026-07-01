"""Standalone text detector (DBNet, PP-OCRv5) used as a fast presence gate.

The extraction loop needs a cheap yes/no "is there text in this band right now?"
signal to decide whether to run full OCR. The historical gate was an edge-density
heuristic (``text_presence``), which misses faint / short cues over busy or bright
backgrounds. RapidOCR's detector is a proper DBNet: a box present means text was
detected (already filtered by the detector's ``box_thresh``), so ``box_count >= 1``
is a far more reliable presence signal than edge density.

CRITICAL PERF: use ``Det.limit_type="max"`` (NOT "min"). Subtitle-band crops are
wide-and-short; ``limit_type="min"`` upscales the SHORT side up to ``limit_side_len``,
blowing the wide side up massively (400-600ms/frame). ``limit_type="max"`` caps the
LONG side instead, so det runs in ~25ms and still detects faint short cues.
"""
from __future__ import annotations

import logging
import threading

import numpy as np

log = logging.getLogger("subextractor")

# Cache detectors by config, like the OCR backends — the det model load is not
# free and the gate is called once per frame per zone.
_det_cache: dict[tuple, "TextDetector"] = {}
# Guards the check-then-set on `_det_cache` against a concurrent double-load.
_det_cache_lock = threading.Lock()


class TextDetector:
    """Thin wrapper over RapidOCR's standalone text detector. ``.detect(bgr)``
    returns the number of detected text boxes (0 = no text present)."""

    def __init__(
        self,
        *,
        ocr_version: str | None = "PP-OCRv5",
        det_model_type: str | None = "mobile",
        limit_type: str = "max",
        limit_side_len: int = 736,
    ) -> None:
        # Lazy import so the package can be absent when this backend is unused.
        from rapidocr import ModelType, OCRVersion, RapidOCR

        def _enum(cls, value):
            try:
                return cls(value) if value else None
            except ValueError:
                log.warning("detector: unsupported value %r for %s; using default", value, cls.__name__)
                return None

        params: dict = {
            "Global.use_rec": False,
            "Global.use_cls": False,
            "Det.limit_type": str(limit_type),
            "Det.limit_side_len": int(limit_side_len),
        }
        if (v := _enum(OCRVersion, ocr_version)) is not None:
            params["Det.ocr_version"] = v
        if (v := _enum(ModelType, det_model_type)) is not None:
            params["Det.model_type"] = v

        self._engine = RapidOCR(params=params)
        # Detector-only entry point; calling it runs det without rec/cls.
        self._td = self._engine.text_det

    def detect(self, bgr: np.ndarray) -> int:
        """Return the count of detected text boxes in ``bgr`` (0 = no text)."""
        out = self._td(bgr)
        boxes = getattr(out, "boxes", None)
        if boxes is None:
            return 0
        try:
            return int(len(boxes))
        except TypeError:
            return 0

    def detect_boxes(self, bgr: np.ndarray) -> list[tuple[int, int, int, int]]:
        """Return axis-aligned bounding boxes ``(x1, y1, x2, y2)`` for every
        detected text region. DBNet emits a 4x2 polygon per box; we reduce each
        to its min/max extent. Empty list when no text is found."""
        out = self._td(bgr)
        boxes = getattr(out, "boxes", None)
        if boxes is None:
            return []
        rects: list[tuple[int, int, int, int]] = []
        for box in boxes:
            pts = np.asarray(box, dtype=np.float32).reshape(-1, 2)
            if pts.size == 0:
                continue
            x1, y1 = pts[:, 0].min(), pts[:, 1].min()
            x2, y2 = pts[:, 0].max(), pts[:, 1].max()
            rects.append((int(x1), int(y1), int(x2), int(y2)))
        return rects

    def close(self) -> None:
        self._engine = None
        self._td = None


def get_detector(
    *,
    ocr_version: str | None = "PP-OCRv5",
    det_model_type: str | None = "mobile",
    limit_type: str = "max",
    limit_side_len: int = 736,
) -> TextDetector:
    """Construct (or fetch the cached) standalone text detector."""
    key = (ocr_version, det_model_type, limit_type, int(limit_side_len))
    cached = _det_cache.get(key)
    if cached is not None:
        return cached
    # Serialize the load; re-check inside the lock (another thread may have built
    # it while we waited) so we never load the same detector twice.
    with _det_cache_lock:
        cached = _det_cache.get(key)
        if cached is not None:
            return cached
        det = TextDetector(
            ocr_version=ocr_version,
            det_model_type=det_model_type,
            limit_type=limit_type,
            limit_side_len=limit_side_len,
        )
        _det_cache[key] = det
        return det


def unload_detectors() -> int:
    """Free all cached detectors. Returns how many were freed."""
    n = len(_det_cache)
    for det in list(_det_cache.values()):
        try:
            det.close()
        except Exception:  # noqa: BLE001
            pass
    _det_cache.clear()
    return n
