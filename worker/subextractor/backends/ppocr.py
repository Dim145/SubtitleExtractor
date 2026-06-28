"""PP-OCRv5 backend via PaddleOCR (CUDA-friendly on the NVIDIA worker).

Requires the optional `ppocr` extra: paddleocr + paddlepaddle (or paddlepaddle-gpu).
"""
from __future__ import annotations

import os

import numpy as np

from .base import OCRBackend, OCRLine


class PPOCRBackend(OCRBackend):
    name = "ppocr"

    def __init__(self, lang: str | None = None, use_gpu: bool | None = None) -> None:
        from paddleocr import PaddleOCR

        if lang is None:
            lang = os.environ.get("PPOCR_LANG", "en")
        if use_gpu is None:
            use_gpu = os.environ.get("PPOCR_USE_GPU", "0").lower() in ("1", "true", "yes")
        self._engine = PaddleOCR(use_angle_cls=True, lang=lang, use_gpu=use_gpu, show_log=False)

    def close(self) -> None:
        self._engine = None
        try:
            import paddle

            paddle.device.cuda.empty_cache()
        except Exception:
            pass

    def recognize(self, image: np.ndarray) -> list[OCRLine]:
        result = self._engine.ocr(image, cls=True)
        # PaddleOCR returns [[ [box, (text, score)], ... ]] (one entry per image).
        if not result or not result[0]:
            return []
        lines: list[OCRLine] = []
        for box, (text, score) in result[0]:
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            lines.append(
                OCRLine(
                    text=str(text).strip(),
                    bbox=(min(xs), min(ys), max(xs), max(ys)),
                    confidence=float(score),
                )
            )
        return lines
