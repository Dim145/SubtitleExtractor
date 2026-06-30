"""OCR backend factory."""
from __future__ import annotations

import gc
from typing import Any

from .base import OCRBackend, OCRLine

__all__ = ["OCRBackend", "OCRLine", "get_backend", "is_loaded", "unload_all"]

# Cache instances by (name, relevant-options) so heavy backends (e.g. the
# PaddleOCR-VL MLX model, ~15s to load) are initialised once and reused, while a
# config change (different model/lang/gpu) builds a fresh instance.
_cache: dict[tuple, OCRBackend] = {}


def get_backend(name: str, **opts: Any) -> OCRBackend:
    name = (name or "rapidocr").lower()
    if name in ("paddleocr-vl", "vl"):
        name = "paddleocr_vl"

    if name == "rapidocr":
        key: tuple = (
            "rapidocr", opts.get("ocr_version"), opts.get("det_model_type"),
            opts.get("rec_model_type"), opts.get("rec_lang"), opts.get("det_box_thresh"),
            opts.get("det_unclip_ratio"), opts.get("det_limit_side_len"), opts.get("text_score"),
        )
    elif name == "ppocr":
        key = ("ppocr", opts.get("lang"), bool(opts.get("use_gpu")))
    elif name == "paddleocr_vl":
        key = ("paddleocr_vl", opts.get("model"))
    else:
        raise ValueError(f"unknown OCR backend: {name!r}")

    cached = _cache.get(key)
    if cached is not None:
        return cached

    if name == "rapidocr":
        from .rapidocr import RapidOCRBackend

        backend: OCRBackend = RapidOCRBackend(
            ocr_version=opts.get("ocr_version") or "PP-OCRv5",
            det_model_type=opts.get("det_model_type") or "mobile",
            rec_model_type=opts.get("rec_model_type") or "mobile",
            rec_lang=opts.get("rec_lang") or "latin",
            det_box_thresh=opts.get("det_box_thresh"),
            det_unclip_ratio=opts.get("det_unclip_ratio"),
            det_limit_side_len=opts.get("det_limit_side_len"),
            text_score=opts.get("text_score"),
        )
    elif name == "ppocr":
        from .ppocr import PPOCRBackend

        backend = PPOCRBackend(lang=opts.get("lang"), use_gpu=opts.get("use_gpu"))
    else:  # paddleocr_vl
        from .paddleocr_vl import PaddleOCRVLBackend

        backend = PaddleOCRVLBackend(model_id=opts.get("model"))

    _cache[key] = backend
    return backend


def is_loaded() -> bool:
    """True if any backend model is currently resident in memory."""
    return bool(_cache)


def unload_all() -> int:
    """Free all loaded backends (releases GPU/VRAM). Returns how many were freed."""
    n = len(_cache)
    for backend in list(_cache.values()):
        try:
            backend.close()
        except Exception:  # noqa: BLE001
            pass
    _cache.clear()
    gc.collect()
    return n
