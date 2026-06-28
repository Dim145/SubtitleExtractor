"""PP-OCRv5 backend via PaddleOCR 3.x (CUDA-friendly on the NVIDIA worker).

Requires the optional `ppocr` extra: paddleocr>=3.7 + paddlepaddle (or the GPU
build paddlepaddle-gpu). PaddleOCR 3.x replaced the old constructor flags
(`use_gpu`, `use_angle_cls`, `show_log`) and the `.ocr()` return shape; this uses
`device=`, `.predict()`, and the `rec_texts` / `rec_scores` / `rec_polys` arrays.
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
        # We OCR tight subtitle-band crops, so disable the full-page
        # orientation / unwarping / textline-rotation modules: they add latency
        # and VRAM and can mis-rotate small crops.
        self._engine = PaddleOCR(
            device="gpu:0" if use_gpu else "cpu",
            lang=lang,
            ocr_version="PP-OCRv5",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
        )

    def close(self) -> None:
        self._engine = None
        try:
            import paddle

            paddle.device.cuda.empty_cache()
        except Exception:
            pass

    def recognize(self, image: np.ndarray) -> list[OCRLine]:
        # PaddleOCR 3.x accepts a BGR numpy array directly.
        results = self._engine.predict(image)
        if not results:
            return []
        lines: list[OCRLine] = []
        for res in results:
            texts = res.get("rec_texts") or []
            scores = res.get("rec_scores")
            polys = res.get("rec_polys")
            if polys is None or len(polys) == 0:
                polys = res.get("dt_polys") or []
            if hasattr(scores, "tolist"):
                scores = scores.tolist()
            for i in range(min(len(texts), len(polys))):
                poly = polys[i]
                if hasattr(poly, "tolist"):
                    poly = poly.tolist()
                xs = [float(p[0]) for p in poly]
                ys = [float(p[1]) for p in poly]
                score = float(scores[i]) if scores is not None and i < len(scores) else 1.0
                lines.append(
                    OCRLine(
                        text=str(texts[i]).strip(),
                        bbox=(min(xs), min(ys), max(xs), max(ys)),
                        confidence=score,
                    )
                )
        return lines
