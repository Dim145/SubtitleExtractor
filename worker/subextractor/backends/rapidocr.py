"""RapidOCR backend (ONNX runtime, PP-OCR models).

This is the default, license-clean path that runs well on Apple Silicon and CPU.
Uses the unified `rapidocr` package (>=2.0), whose engine returns a
RapidOCROutput with parallel ``boxes`` / ``txts`` / ``scores`` arrays.
"""
from __future__ import annotations

import numpy as np

from .base import OCRBackend, OCRLine


class RapidOCRBackend(OCRBackend):
    name = "rapidocr"

    def __init__(self) -> None:
        # Imported lazily so the package can be installed without this backend.
        from rapidocr import RapidOCR

        self._engine = RapidOCR()

    def close(self) -> None:
        self._engine = None

    def recognize(self, image: np.ndarray) -> list[OCRLine]:
        out = self._engine(image)
        boxes = getattr(out, "boxes", None)
        txts = getattr(out, "txts", None)
        scores = getattr(out, "scores", None)
        if boxes is None or txts is None or scores is None:
            return []
        lines: list[OCRLine] = []
        for box, text, score in zip(boxes, txts, scores):
            # box is a 4x2 array of [x, y] points; reduce to an axis-aligned bbox.
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            lines.append(
                OCRLine(
                    text=str(text).strip(),
                    bbox=(min(xs), min(ys), max(xs), max(ys)),
                    confidence=float(score),
                )
            )
        return lines
