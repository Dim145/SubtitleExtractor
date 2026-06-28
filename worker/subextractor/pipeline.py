"""End-to-end extraction pipeline for one job.

Resolution order for every parameter: job params (user) > worker config (admin,
from DB) > built-in default. Supports up to two subtitle zones; a single decode
feeds all zones, each with its own SSIM-skip + OCR + merge, then cues are combined.
"""
from __future__ import annotations

import json
import os
import tempfile
from typing import Any

import cv2
import numpy as np

from .backends import OCRBackend, get_backend
from .client import APIClient
from .config import Config
from .dedup import (
    Cue,
    alignment_from_bbox,
    mask_diff_ratio,
    merge_into_cues,
    text_mask,
    text_presence,
)
from .formats import write_ass, write_srt, write_vtt
from .video import probe, sample_frames_auto

# Built-in fallbacks when neither the job nor the worker config specify a value.
DEFAULT_FPS = 4.0
# Lower per-line confidence floor: recall first, then precision via post-filters.
DEFAULT_MIN_CONFIDENCE = 0.4
DEFAULT_BACKEND = "rapidocr"


def _as_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str) and raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}
    return {}


def _pick(params: dict, wcfg: dict, key: str, default: Any) -> Any:
    if params.get(key) is not None:
        return params[key]
    if wcfg.get(key) is not None:
        return wcfg[key]
    return default


def _resolve_zones(params: dict, wcfg: dict, width: int, height: int) -> list[tuple[int, int, int, int]]:
    """Return a list of (x, y, w, h) pixel rects for the subtitle zones."""
    zones = params.get("zones") or wcfg.get("zones")
    rects: list[tuple[int, int, int, int]] = []
    if zones:
        for z in zones[:2]:
            x = int(round(float(z.get("x", 0)) * width))
            y = int(round(float(z.get("y", 0)) * height))
            w = int(round(float(z.get("w", 1)) * width))
            h = int(round(float(z.get("h", 1)) * height))
            x = max(0, min(x, width - 1))
            y = max(0, min(y, height - 1))
            w = max(1, min(w, width - x))
            h = max(1, min(h, height - y))
            rects.append((x, y, w, h))
    if not rects:
        # Default: bottom ~38% band, where burned-in subtitles usually sit.
        y = int(height * 0.62)
        rects.append((0, y, width, height - y))
    return rects


def process_job(cfg: Config, client: APIClient, job: dict[str, Any], input_url: str, wcfg: dict | None = None) -> None:
    job_id = job["id"]
    params = _as_dict(job.get("params"))
    wcfg = wcfg or {}

    sample_fps = float(_pick(params, wcfg, "fps", DEFAULT_FPS))
    backend_name = _pick(params, wcfg, "ocr_backend", DEFAULT_BACKEND) or DEFAULT_BACKEND
    min_conf = float(_pick(params, wcfg, "min_confidence", DEFAULT_MIN_CONFIDENCE))
    language = params.get("language")
    formats = params.get("formats") or ["srt", "ass"]

    # Quality knobs (admin/job tunable).
    upscale = float(_pick(params, wcfg, "upscale", 2.0))
    presence_thr = float(_pick(params, wcfg, "text_presence_threshold", 0.008))
    change_thr = float(_pick(params, wcfg, "change_threshold", 0.01))
    min_frames = int(_pick(params, wcfg, "min_frames", 2))
    min_duration = float(_pick(params, wcfg, "min_subtitle_duration", 0.4))
    drop_junk = bool(_pick(params, wcfg, "drop_junk", True))
    char_voting = bool(_pick(params, wcfg, "char_voting", True))

    with tempfile.TemporaryDirectory(prefix="subext-") as tmp:
        video_path = os.path.join(tmp, job.get("sourceFilename") or "input.bin")

        client.progress(job_id, 2, "downloading", log="downloading input video")
        client.download(input_url, video_path)

        client.progress(job_id, 6, "loading_model", log=f"loading OCR backend: {backend_name}")
        backend: OCRBackend = get_backend(
            backend_name,
            lang=_pick(params, wcfg, "ppocr_lang", None),
            use_gpu=_pick(params, wcfg, "ppocr_use_gpu", None),
            model=_pick(params, wcfg, "paddleocr_vl_model", None),
        )
        decoder = _pick(params, wcfg, "decoder", None)
        hwaccel = _pick(params, wcfg, "hwaccel", None)

        info = probe(video_path)
        zones = _resolve_zones(params, wcfg, info.width, info.height)
        est_total = max(1, int(info.duration * sample_fps))
        frame_interval = 1.0 / sample_fps
        client.log(
            job_id,
            f"video {info.width}x{info.height} @ {info.fps:.2f}fps, ~{info.duration:.0f}s, {len(zones)} zone(s)",
        )

        # Per-zone accumulators. Alignment comes from the zone position (stable,
        # independent of OCR boxes / upscaling).
        samples: list[list[tuple[float, str, int, float]]] = [[] for _ in zones]
        zone_an = [alignment_from_bbox((0, 0, zw, zh), info.width, info.height, zx, zy)
                   for (zx, zy, zw, zh) in zones]
        prev_mask: list[Any] = [None for _ in zones]
        prev_lines: list[list] = [[] for _ in zones]

        for i, sf in enumerate(sample_frames_auto(video_path, sample_fps, decoder, hwaccel)):
            for zi, (zx, zy, zw, zh) in enumerate(zones):
                crop = sf.image[zy:zy + zh, zx:zx + zw]
                gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
                mask = text_mask(gray)
                fg = float(np.count_nonzero(mask)) / max(1, mask.size)

                if fg < 0.002 or text_presence(gray) < presence_thr:
                    lines = []  # no text-like content → skip OCR (avoids hallucinations)
                elif prev_mask[zi] is not None and mask_diff_ratio(mask, prev_mask[zi]) < change_thr:
                    lines = prev_lines[zi]  # text unchanged → reuse last reading
                else:
                    ocr_img = crop
                    if upscale > 1.0:
                        ocr_img = cv2.resize(crop, None, fx=upscale, fy=upscale, interpolation=cv2.INTER_CUBIC)
                    lines = backend.recognize(ocr_img)
                prev_mask[zi], prev_lines[zi] = mask, lines

                good = [l for l in lines if l.confidence >= min_conf and l.text.strip()]
                text = "\n".join(l.text for l in good if l.text)
                conf = (sum(l.confidence for l in good) / len(good)) if good else 1.0
                samples[zi].append((sf.timestamp, text, zone_an[zi], conf))

            if i % 15 == 0:
                pct = 6 + int(min(80, (i / est_total) * 80))
                client.progress(job_id, pct, "ocr", log=f"frame {i}/{est_total}")

        client.progress(job_id, 88, "merging", log="merging frames into cues")
        cues: list[Cue] = []
        for zi in range(len(zones)):
            cues.extend(
                merge_into_cues(
                    samples[zi],
                    frame_interval=frame_interval,
                    min_duration=min_duration,
                    min_frames=min_frames,
                    drop_junk=drop_junk,
                    char_voting=char_voting,
                )
            )
        cues.sort(key=lambda c: c.start)
        client.log(job_id, f"produced {len(cues)} subtitle cues")
        if not cues:
            client.log(job_id, "no subtitles detected", level="warn")

        client.progress(job_id, 94, "writing", log=f"writing formats: {', '.join(formats)}")
        if "srt" in formats:
            srt_path = os.path.join(tmp, "subtitles.srt")
            write_srt(cues, srt_path)
            client.upload_result(job_id, srt_path, kind="srt", language=language)
        if "ass" in formats:
            ass_path = os.path.join(tmp, "subtitles.ass")
            write_ass(cues, ass_path, info.width, info.height)
            client.upload_result(job_id, ass_path, kind="ass", language=language)
        if "vtt" in formats:
            vtt_path = os.path.join(tmp, "subtitles.vtt")
            write_vtt(cues, vtt_path)
            client.upload_result(job_id, vtt_path, kind="vtt", language=language)

        client.progress(job_id, 100, "done", log="extraction complete")
