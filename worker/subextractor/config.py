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
            "default": 0.4,
            "min": 0,
            "max": 1,
            "step": 0.05,
            "help": "Per-line OCR score floor. Kept low for recall; precision is enforced by the persistence/duration/junk filters below.",
        },
        {
            "key": "upscale",
            "label": "Crop upscale",
            "type": "number",
            "default": 2.0,
            "min": 1,
            "max": 4,
            "step": 0.5,
            "help": "Enlarge the subtitle crop before OCR (helps small/thin text). 1 = off.",
        },
        {
            "key": "use_detector_gate",
            "label": "Detector presence gate",
            "type": "boolean",
            "default": True,
            "help": "Gate OCR on a DBNet text detector instead of edge density. Better recall on faint/short cues (~25ms/frame). Off = use the edge-density gate below.",
        },
        {
            "key": "detector_limit_side_len",
            "label": "Detector limit side len",
            "type": "number",
            "default": 736,
            "min": 256,
            "max": 1536,
            "step": 32,
            "help": "Long-side cap for the presence detector (limit_type=max). Higher = detects smaller text, slower. Only used when the detector gate is on.",
        },
        {
            "key": "text_presence_threshold",
            "label": "Text-presence gate (fallback)",
            "type": "number",
            "default": 0.008,
            "min": 0,
            "max": 0.1,
            "step": 0.002,
            "help": "Edge-density fallback gate, used when the detector gate is off. Min edge density for a frame to be OCR'd. 0 = always OCR.",
        },
        {
            "key": "change_threshold",
            "label": "Frame-change threshold",
            "type": "number",
            "default": 0.01,
            "min": 0,
            "max": 0.2,
            "step": 0.005,
            "help": "Min fraction of changed text-mask pixels to re-run OCR. Lower = catches more text changes, slower.",
        },
        {
            "key": "min_frames",
            "label": "Min frames per cue",
            "type": "number",
            "default": 2,
            "min": 1,
            "max": 20,
            "step": 1,
            "help": "Drop cues seen in fewer frames than this (kills single-frame flicker).",
        },
        {
            "key": "min_subtitle_duration",
            "label": "Min subtitle duration (s)",
            "type": "number",
            "default": 0.4,
            "min": 0,
            "max": 5,
            "step": 0.1,
            "help": "Drop cues shorter than this after merging.",
        },
        {
            "key": "drop_junk",
            "label": "Drop junk cues",
            "type": "boolean",
            "default": True,
            "help": "Discard empty / pure-digit-punctuation flickers (e.g. stray '11', '0:0').",
        },
        {
            "key": "char_voting",
            "label": "Character-level voting",
            "type": "boolean",
            "default": True,
            "help": "Vote each cue's text character-by-character across its frames, weighted by OCR confidence (repairs single-character misreads). Off = plain majority of whole readings.",
        },
        {
            "key": "normalize_text",
            "label": "French text normalizer",
            "type": "boolean",
            "default": True,
            "help": "French jobs only: restore missing elision apostrophes (j'ai, qu'il, d'enfance) and split run-together words (pas trop) using a validated French wordlist. Deterministic, no effect on other languages.",
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
             "default": "mlx-community/PaddleOCR-VL-1.5-8bit",
             "help": "MLX model id for the paddleocr_vl backend. 1.5-8bit balances quality/size; -bf16 is highest fidelity, -4bit the lightest."},
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
