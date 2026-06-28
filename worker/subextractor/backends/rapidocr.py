"""RapidOCR backend (ONNX runtime, PP-OCR models).

This is the default, license-clean path that runs well on Apple Silicon and CPU.
"""
from __future__ import annotations

import numpy as np

from .base import OCRBackend, OCRLine


class RapidOCRBackend(OCRBackend):
    name = "rapidocr"

    def __init__(self) -> None:
        # Imported lazily so the package can be installed without this backend.
        from rapidocr_onnxruntime import RapidOCR

        self._engine = RapidOCR()

    def close(self) -> None:
        self._engine = None

    def recognize(self, image: np.ndarray) -> list[OCRLine]:
        result, _ = self._engine(image)
        if not result:
            return []
        lines: list[OCRLine] = []
        for box, text, score in result:
            # box is 4 points [[x,y],...]; reduce to an axis-aligned bbox.
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            lines.append(
                OCRLine(
                    text=text.strip(),
                    bbox=(min(xs), min(ys), max(xs), max(ys)),
                    confidence=float(score),
                )
            )
        return lines
