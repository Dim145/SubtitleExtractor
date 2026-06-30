"""RapidOCR backend (ONNX runtime, PP-OCR models).

This is the default, license-clean path that runs well on Apple Silicon and CPU.
Uses the unified `rapidocr` package (>=3.0), whose engine returns a
RapidOCROutput with parallel ``boxes`` / ``txts`` / ``scores`` arrays.

Model + detection thresholds are configurable (RapidOCR 3.x `params=` with
dotted keys). Defaults target burned-in subtitles in Latin scripts:
PP-OCRv5 detection + the dedicated ``latin_PP-OCRv5_rec_mobile`` recognizer,
with a slightly looser detector (lower ``box_thresh``, larger ``unclip_ratio``,
higher ``limit_side_len``) to favour recall on faint / small subtitle text.
"""
from __future__ import annotations

import logging

import numpy as np

from .base import OCRBackend, OCRLine

log = logging.getLogger("subextractor")


class RapidOCRBackend(OCRBackend):
    name = "rapidocr"

    def __init__(
        self,
        *,
        ocr_version: str | None = "PP-OCRv5",
        det_model_type: str | None = "mobile",
        rec_model_type: str | None = "mobile",
        rec_lang: str | None = "latin",
        det_box_thresh: float | None = None,
        det_unclip_ratio: float | None = None,
        det_limit_side_len: int | None = None,
        text_score: float | None = None,
    ) -> None:
        # Imported lazily so the package can be installed without this backend.
        from rapidocr import LangRec, ModelType, OCRVersion, RapidOCR

        params: dict = {}

        # Model / version selection. Build enums by value; skip an unknown value
        # rather than crash (falls back to RapidOCR's own default for that slot).
        def _enum(cls, value):
            try:
                return cls(value) if value else None
            except ValueError:
                log.warning("rapidocr: unsupported value %r for %s; using default", value, cls.__name__)
                return None

        if (v := _enum(OCRVersion, ocr_version)) is not None:
            params["Det.ocr_version"] = v
            params["Rec.ocr_version"] = v
        if (v := _enum(ModelType, det_model_type)) is not None:
            params["Det.model_type"] = v
        if (v := _enum(ModelType, rec_model_type)) is not None:
            params["Rec.model_type"] = v
        if (v := _enum(LangRec, rec_lang)) is not None:
            params["Rec.lang_type"] = v

        # Detection post-processing knobs (recall/precision tuning).
        if det_box_thresh is not None:
            params["Det.box_thresh"] = float(det_box_thresh)
        if det_unclip_ratio is not None:
            params["Det.unclip_ratio"] = float(det_unclip_ratio)
        if det_limit_side_len is not None:
            params["Det.limit_side_len"] = int(det_limit_side_len)
        # RapidOCR drops recognitions below Global.text_score (default 0.5) BEFORE
        # we ever see them — align it with our own floor so we, not the engine,
        # control filtering (otherwise lines in [our floor, 0.5) silently vanish).
        if text_score is not None:
            params["Global.text_score"] = float(text_score)

        self._engine = RapidOCR(params=params)

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
