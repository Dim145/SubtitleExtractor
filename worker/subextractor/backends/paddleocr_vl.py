"""PaddleOCR-VL backend running on the Apple GPU via MLX (Metal).

This is the Apple-Silicon GPU path: the model runs on Metal through mlx-vlm,
not on the CPU. It's a vision-language model, so for a tight subtitle-band crop
it returns the recognized text directly (prompt "OCR:"). We expose that as a
single OCRLine spanning the crop — alignment then comes from the zone position.

Heavier per call than PP-OCR, so rely on the pipeline's SSIM frame-skip. Install
with the optional extra:  pip install -e ".[mlx]"   (Apple Silicon only)
"""
from __future__ import annotations

import os
import tempfile
from collections import Counter

import cv2
import numpy as np

from .base import OCRBackend, OCRLine

DEFAULT_MODEL = "mlx-community/PaddleOCR-VL-1.5-4bit"
OCR_PROMPT = "OCR:"


def _is_degenerate(text: str) -> bool:
    """True when the VLM output looks like a repetition loop / single-char spam —
    the classic VLM hallucination on a near-empty crop (e.g. "1111111", "的的的的")."""
    t = text.strip()
    if len(t) < 6:
        return False
    body = t.replace(" ", "")
    if body:
        char, n = Counter(body).most_common(1)[0]
        if n / len(body) > 0.6:  # one character dominates
            return True
    tokens = t.split()
    if len(tokens) >= 6:
        _, n = Counter(tokens).most_common(1)[0]
        if n / len(tokens) > 0.5:  # one word repeated over and over
            return True
    trigrams = [t[i:i + 3] for i in range(len(t) - 2)]
    if trigrams:
        _, n = Counter(trigrams).most_common(1)[0]
        if n > max(4, len(trigrams) * 0.3):  # a 3-gram loops
            return True
    return False


class PaddleOCRVLBackend(OCRBackend):
    name = "paddleocr_vl"

    def __init__(self, model_id: str | None = None) -> None:
        # Imported lazily so the package installs/runs without MLX on non-Mac hosts.
        from mlx_vlm import generate, load
        from mlx_vlm.prompt_utils import apply_chat_template
        from mlx_vlm.utils import load_config

        self._generate = generate
        self._apply_chat_template = apply_chat_template
        self.model_id = model_id or os.environ.get("PADDLEOCR_VL_MODEL", DEFAULT_MODEL)
        try:
            self._rep_penalty = float(os.environ.get("PADDLEOCR_VL_REPETITION_PENALTY", "1.05"))
        except ValueError:
            self._rep_penalty = 1.05
        # Loaded once and kept resident — reloading per frame would dominate runtime.
        self._model, self._processor = load(self.model_id)
        self._config = load_config(self.model_id)

    def close(self) -> None:
        self._model = None
        self._processor = None
        try:
            import mlx.core as mx

            # Free the Metal buffer cache (API name varies across mlx versions).
            clear = getattr(mx, "clear_cache", None) or getattr(getattr(mx, "metal", None), "clear_cache", None)
            if clear:
                clear()
        except Exception:
            pass

    def recognize(self, image: np.ndarray) -> list[OCRLine]:
        from PIL import Image

        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        pil = Image.fromarray(rgb)

        path = ""
        try:
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
                path = f.name
            pil.save(path)
            prompt = self._apply_chat_template(self._processor, self._config, OCR_PROMPT, num_images=1)
            # Anti-hallucination knobs: greedy decode (temp 0), a tight token budget
            # (subtitle bands are short — long output is almost always a loop), and a
            # mild repetition penalty. The penalty kwarg name varies across mlx_vlm
            # versions, so it's applied opportunistically and dropped if unsupported.
            gen_kwargs = dict(max_tokens=96, temperature=0.0, verbose=False)
            try:
                result = self._generate(
                    self._model, self._processor, prompt, image=[path],
                    repetition_penalty=self._rep_penalty, **gen_kwargs,
                )
            except TypeError:
                result = self._generate(
                    self._model, self._processor, prompt, image=[path], **gen_kwargs,
                )
        finally:
            if path:
                try:
                    os.remove(path)
                except OSError:
                    pass

        text = getattr(result, "text", result)
        text = (text or "").strip()
        if not text or _is_degenerate(text):
            return []
        h, w = image.shape[:2]
        # The VLM gives no per-line box/confidence; the crop IS the line region.
        return [OCRLine(text=text, bbox=(0.0, 0.0, float(w), float(h)), confidence=1.0)]
