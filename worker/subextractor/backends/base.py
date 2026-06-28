"""OCR backend abstraction.

A backend takes a BGR image (numpy array) and returns the detected text lines,
each with a bounding box and a confidence score. The pipeline is backend-agnostic;
only this contract matters.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

import numpy as np


@dataclass
class OCRLine:
    text: str
    # Axis-aligned bbox in the coordinates of the image passed to recognize():
    # (x1, y1, x2, y2).
    bbox: tuple[float, float, float, float]
    confidence: float


class OCRBackend(ABC):
    name: str = "base"

    @abstractmethod
    def recognize(self, image: np.ndarray) -> list[OCRLine]:
        """Run detection + recognition on a single image."""
        raise NotImplementedError

    def close(self) -> None:
        """Release model resources (e.g. GPU/VRAM). Default: no-op."""
        return None
