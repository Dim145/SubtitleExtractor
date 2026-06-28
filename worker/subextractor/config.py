"""Worker bootstrap configuration (env). OCR parameters themselves come from the
API (DB-backed, admin-editable) via the heartbeat — not from env. The worker
advertises which backends it has and a typed config schema so the admin UI can
render a proper form instead of raw JSON."""
from __future__ import annotations

import importlib.util
import os
import socket
from dataclasses import dataclass, field


def _available_backends() -> list[str]:
    """Detect installed OCR backends without importing heavy modules."""
    backends = ["rapidocr"]  # core dependency, always present
    if importlib.util.find_spec("mlx_vlm") is not None:
        backends.append("paddleocr_vl")
    if importlib.util.find_spec("paddleocr") is not None:
        backends.append("ppocr")
    return backends


def _config_schema(backends: list[str], worker_class: str) -> list[dict]:
    """Typed parameter descriptors consumed by the admin dynamic form. Every
    runtime-tunable setting (previously an env var) is exposed here so it can be
    edited per worker from the web UI — for both the macOS and NVIDIA workers."""
    hwaccel_options = {
        "macos": ["videotoolbox", "none"],
        "gpu-nvidia": ["cuda", "none"],
    }.get(worker_class, ["none", "videotoolbox", "cuda"])

    schema: list[dict] = [
        {
            "key": "ocr_backend",
            "label": "OCR backend",
            "type": "select",
            "default": backends[0],
            "options": backends,
            "help": "Recognition engine. paddleocr_vl uses the Apple GPU (more accurate, slower); ppocr is CUDA.",
        },
        {
            "key": "decoder",
            "label": "Video decoder",
            "type": "select",
            "default": "opencv",
            "options": ["opencv", "ffmpeg"],
            "help": "ffmpeg enables hardware decode (NVDEC / VideoToolbox) via the accelerator below.",
        },
        {
            "key": "hwaccel",
            "label": "Hardware accel (ffmpeg)",
            "type": "select",
            "default": hwaccel_options[0],
            "options": hwaccel_options,
            "help": "Used only when the decoder is ffmpeg.",
        },
        {
            "key": "fps",
            "label": "Sample rate (fps)",
            "type": "number",
            "default": 4,
            "min": 0.5,
            "max": 30,
            "step": 0.5,
            "help": "Frames sampled per second. Higher = finer timing, slower.",
        },
        {
            "key": "min_confidence",
            "label": "Min confidence",
            "type": "number",
            "default": 0.6,
            "min": 0,
            "max": 1,
            "step": 0.05,
            "help": "Drop OCR detections below this score (cuts noise).",
        },
        {
            "key": "poll_interval",
            "label": "Poll interval (s)",
            "type": "number",
            "default": 3,
            "min": 1,
            "max": 60,
            "step": 1,
            "help": "How often the worker checks for new jobs.",
        },
        {
            "key": "model_unload_grace",
            "label": "Model unload grace (s)",
            "type": "number",
            "default": 300,
            "min": 0,
            "max": 3600,
            "step": 30,
            "help": "Free the OCR model from memory (GPU/VRAM) after this long idle. 0 = keep loaded. Loaded on demand when a job arrives.",
        },
    ]
    if "ppocr" in backends:
        schema += [
            {"key": "ppocr_lang", "label": "PP-OCR language", "type": "text", "default": "en",
             "help": "PaddleOCR language code (e.g. en, fr, ch). Applies to the ppocr backend."},
            {"key": "ppocr_use_gpu", "label": "PP-OCR on GPU", "type": "boolean", "default": True,
             "help": "Run PaddleOCR on CUDA (requires paddlepaddle-gpu)."},
        ]
    if "paddleocr_vl" in backends:
        schema.append(
            {"key": "paddleocr_vl_model", "label": "PaddleOCR-VL model", "type": "text",
             "default": "mlx-community/PaddleOCR-VL-1.5-4bit",
             "help": "MLX model id for the paddleocr_vl backend."},
        )
    return schema


@dataclass
class Config:
    api_base_url: str
    internal_token: str
    worker_name: str
    worker_class: str
    poll_interval: float
    capabilities: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls) -> "Config":
        worker_class = os.environ.get("WORKER_CLASS", "macos")
        backends = _available_backends()
        capabilities = {
            "backends": backends,
            "config_schema": _config_schema(backends, worker_class),
        }
        return cls(
            api_base_url=os.environ.get("API_BASE_URL", "http://localhost:8080").rstrip("/"),
            internal_token=os.environ["INTERNAL_API_TOKEN"],
            worker_name=os.environ.get("WORKER_ID", f"{worker_class}-{socket.gethostname()}"),
            worker_class=worker_class,
            poll_interval=float(os.environ.get("WORKER_POLL_INTERVAL", "3")),
            capabilities=capabilities,
        )
