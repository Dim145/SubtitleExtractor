"""End-to-end extraction pipeline for one job.

Resolution order for every parameter: job params (user) > worker config (admin,
from DB) > built-in default. Supports up to two subtitle zones; a single decode
feeds all zones, each with its own change-skip + OCR + merge, then cues are
combined.

The OCR core is exposed as `extract_cues()` — a pure, API-client-free function
that takes a resolved config and a backend and returns timed cues. `process_job`
wraps it with download / progress / heartbeat / upload; the eval harness calls
`extract_cues` directly to A/B configs.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from typing import Any, Callable

import cv2
import numpy as np

from .backends import OCRBackend, get_backend
from .client import APIClient
from .config import Config
from .dedup import (
    Cue,
    alignment_from_bbox,
    apply_substitution_rules,
    estimate_text_height,
    focus_measure,
    mask_diff_ratio,
    merge_into_cues,
    non_latin_ratio,
    text_mask,
    text_presence,
)
from .formats import write_ass, write_srt, write_vtt
from .video import VideoInfo, probe, sample_frames_auto

# Built-in fallbacks when neither the job nor the worker config specify a value.
DEFAULT_FPS = 4.0
# Lower per-line confidence floor: recall first, then precision via post-filters.
DEFAULT_MIN_CONFIDENCE = 0.4
DEFAULT_BACKEND = "rapidocr"

# Map a job language to a RapidOCR recognition model family. Latin covers
# fr/en/es/de/it/pt… (the project's primary target). Unknown → latin.
_REC_LANG_BY_LANGUAGE = {
    "fr": "latin", "fra": "latin", "fre": "latin",
    "en": "latin", "eng": "latin",
    "es": "latin", "spa": "latin", "de": "latin", "deu": "latin", "ger": "latin",
    "it": "latin", "ita": "latin", "pt": "latin", "por": "latin",
    "nl": "latin", "ca": "latin", "ro": "latin", "pl": "latin", "vi": "latin",
    "ja": "japan", "jp": "japan", "jpn": "japan",
    "ko": "korean", "kor": "korean",
    "zh": "ch", "zho": "ch", "chi": "ch", "cmn": "ch",
    "ru": "cyrillic", "rus": "cyrillic", "uk": "cyrillic", "bg": "cyrillic", "sr": "cyrillic",
}


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


def _rec_lang(language: str | None, override: Any) -> str:
    if override:
        return str(override)
    if language:
        return _REC_LANG_BY_LANGUAGE.get(str(language).lower().split("-")[0], "latin")
    return "latin"


def resolve_config(params: dict, wcfg: dict) -> dict[str, Any]:
    """Resolve every tunable knob into a flat config dict (job > worker > default)."""
    min_conf = float(_pick(params, wcfg, "min_confidence", DEFAULT_MIN_CONFIDENCE))
    language = params.get("language")
    return {
        "backend": _pick(params, wcfg, "ocr_backend", DEFAULT_BACKEND) or DEFAULT_BACKEND,
        "fps": float(_pick(params, wcfg, "fps", DEFAULT_FPS)),
        "min_confidence": min_conf,
        "language": language,
        "zones": params.get("zones") or wcfg.get("zones"),
        "decoder": _pick(params, wcfg, "decoder", None),
        "hwaccel": _pick(params, wcfg, "hwaccel", None),
        # RapidOCR model selection + detection tuning (recall/precision).
        "ocr_version": _pick(params, wcfg, "ocr_version", "PP-OCRv5"),
        "det_model_type": _pick(params, wcfg, "det_model_type", "mobile"),
        "rec_model_type": _pick(params, wcfg, "rec_model_type", "mobile"),
        "rec_lang": _rec_lang(language, _pick(params, wcfg, "rec_lang", None)),
        "det_box_thresh": float(_pick(params, wcfg, "det_box_thresh", 0.4)),
        "det_unclip_ratio": float(_pick(params, wcfg, "det_unclip_ratio", 1.8)),
        # Keep RapidOCR's native 736: limit_type="min" scales the band's SHORT side
        # up to this, and our crops are already adaptively upscaled — inflating it
        # double-scales (slower + distorts). Raise only for full-frame detection.
        "det_limit_side_len": int(_pick(params, wcfg, "det_limit_side_len", 736)),
        # Keep RapidOCR's internal score filter aligned with our own floor so it
        # doesn't silently drop lines we'd otherwise keep.
        "text_score": float(_pick(params, wcfg, "text_score", min_conf)),
        # Pre-OCR scaling: adaptive toward a target glyph height, capped.
        "upscale": float(_pick(params, wcfg, "upscale", 2.0)),
        "target_text_height": float(_pick(params, wcfg, "target_text_height", 40.0)),
        "max_scale": float(_pick(params, wcfg, "max_scale", 4.0)),
        # Gating + merge.
        "text_presence_threshold": float(_pick(params, wcfg, "text_presence_threshold", 0.008)),
        "change_threshold": float(_pick(params, wcfg, "change_threshold", 0.01)),
        "min_frames": int(_pick(params, wcfg, "min_frames", 2)),
        "min_subtitle_duration": float(_pick(params, wcfg, "min_subtitle_duration", 0.4)),
        # Max gap to bridge two near-identical consecutive cues into one. A single
        # subtitle often splits across a brief (~0.5s) detection dropout; 0.4 was
        # too tight and left duplicates. sim_threshold still guards against merging
        # genuinely different lines.
        "min_gap": float(_pick(params, wcfg, "min_gap", 1.0)),
        "drop_junk": bool(_pick(params, wcfg, "drop_junk", True)),
        "char_voting": bool(_pick(params, wcfg, "char_voting", True)),
        # Drop cues whose script doesn't match a Latin job (VLM CJK hallucinations).
        "drop_foreign_script": bool(_pick(params, wcfg, "drop_foreign_script", True)),
        # Best-frame re-OCR within a stable group (sharper frame → better read).
        # Off by default: it roughly triples OCR cost and its accuracy benefit is
        # unproven on this content — enable + measure with the eval harness before
        # turning it on for real.
        "best_frame": bool(_pick(params, wcfg, "best_frame", False)),
        "best_frame_margin": float(_pick(params, wcfg, "best_frame_margin", 0.15)),
        "max_ocr_per_group": int(_pick(params, wcfg, "max_ocr_per_group", 2)),
        # Other backends.
        "ppocr_lang": _pick(params, wcfg, "ppocr_lang", None),
        "ppocr_use_gpu": _pick(params, wcfg, "ppocr_use_gpu", None),
        "paddleocr_vl_model": _pick(params, wcfg, "paddleocr_vl_model", None),
    }


def build_backend(cfg: dict) -> OCRBackend:
    """Construct (or fetch the cached) OCR backend for a resolved config."""
    return get_backend(
        cfg.get("backend", DEFAULT_BACKEND),
        lang=cfg.get("ppocr_lang"),
        use_gpu=cfg.get("ppocr_use_gpu"),
        model=cfg.get("paddleocr_vl_model"),
        ocr_version=cfg.get("ocr_version"),
        det_model_type=cfg.get("det_model_type"),
        rec_model_type=cfg.get("rec_model_type"),
        rec_lang=cfg.get("rec_lang"),
        det_box_thresh=cfg.get("det_box_thresh"),
        det_unclip_ratio=cfg.get("det_unclip_ratio"),
        det_limit_side_len=cfg.get("det_limit_side_len"),
        text_score=cfg.get("text_score"),
    )


def _resolve_zones(zones: Any, width: int, height: int) -> list[tuple[int, int, int, int]]:
    """Return a list of (x, y, w, h) pixel rects for the subtitle zones."""
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


def _order_text(lines: list) -> str:
    """Join detected boxes in reading order. The detector returns boxes in an
    arbitrary order; concatenating them as-is scrambles multi-word / multi-line
    subtitles. Group boxes into rows by vertical overlap, order rows top→bottom
    and boxes left→right, join boxes within a row by a space and rows by newline."""
    items = [l for l in lines if l.text.strip()]
    if not items:
        return ""
    if len(items) == 1:
        return items[0].text
    heights = sorted((l.bbox[3] - l.bbox[1]) for l in items)
    row_tol = 0.6 * (heights[len(heights) // 2] or 1.0)
    rows: list[list] = []  # each: [running_y_center, count, [lines]]
    for l in sorted(items, key=lambda l: (l.bbox[1] + l.bbox[3]) / 2.0):
        yc = (l.bbox[1] + l.bbox[3]) / 2.0
        for row in rows:
            if abs(yc - row[0]) <= row_tol:
                row[2].append(l)
                row[1] += 1
                row[0] += (yc - row[0]) / row[1]  # incremental mean y-center
                break
        else:
            rows.append([yc, 1, [l]])
    rows.sort(key=lambda r: r[0])
    out = []
    for _, _, rl in rows:
        rl.sort(key=lambda l: l.bbox[0])
        out.append(" ".join(l.text for l in rl))
    return "\n".join(out)


# Below this foreground ratio a crop has no text-like content at all → skip OCR.
_MIN_FG_RATIO = 0.002
# Throttle progress callbacks: every N frames, or every few seconds in between.
_PROGRESS_EVERY = 15
_PROGRESS_SECS = 3.0


def extract_cues(
    video_path: str,
    backend: OCRBackend,
    cfg: dict,
    *,
    on_progress: Callable[[int, int], None] | None = None,
    log: Callable[[str], None] | None = None,
) -> tuple[list[Cue], VideoInfo]:
    """Decode, OCR and merge a video into timed cues. Pure: no API client, no
    uploads. `on_progress(frame_index, est_total)` is called periodically and may
    raise to abort (e.g. cancellation). Returns (cues, video_info)."""
    sample_fps = float(cfg.get("fps", DEFAULT_FPS))
    min_conf = float(cfg.get("min_confidence", DEFAULT_MIN_CONFIDENCE))
    upscale = float(cfg.get("upscale", 2.0))
    target_h = float(cfg.get("target_text_height", 40.0))
    max_scale = float(cfg.get("max_scale", 4.0))
    presence_thr = float(cfg.get("text_presence_threshold", 0.008))
    change_thr = float(cfg.get("change_threshold", 0.01))
    best_frame = bool(cfg.get("best_frame", True))
    best_margin = float(cfg.get("best_frame_margin", 0.15))
    max_ocr_grp = int(cfg.get("max_ocr_per_group", 3))

    def _ocr(crop: np.ndarray, mask: np.ndarray) -> list:
        """OCR a crop, scaling it toward the target glyph height (capped)."""
        scale = min(max_scale, upscale)  # fallback when height can't be estimated
        if target_h > 0:
            th = estimate_text_height(mask)
            if th > 0:
                scale = max(1.0, min(max_scale, target_h / th))
        img = crop
        if scale > 1.01:
            img = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        return backend.recognize(img)

    info = probe(video_path)
    zones = _resolve_zones(cfg.get("zones"), info.width, info.height)
    est_total = max(1, int(info.duration * sample_fps))
    frame_interval = 1.0 / sample_fps  # replaced by the decoder's REAL interval below
    if log:
        log(f"video {info.width}x{info.height} @ {info.fps:.2f}fps, ~{info.duration:.0f}s, {len(zones)} zone(s)")

    samples: list[list[tuple[float, str, int, float]]] = [[] for _ in zones]
    zone_an = [alignment_from_bbox((0, 0, zw, zh), info.width, info.height, zx, zy)
               for (zx, zy, zw, zh) in zones]
    prev_mask: list[Any] = [None for _ in zones]
    prev_lines: list[list] = [[] for _ in zones]
    grp_best: list[float] = [0.0 for _ in zones]   # best sharpness in current group
    grp_ocr: list[int] = [0 for _ in zones]         # OCR calls spent on current group

    last_poll = time.monotonic()
    for i, sf in enumerate(sample_frames_auto(video_path, sample_fps, cfg.get("decoder"), cfg.get("hwaccel"))):
        if i == 0 and sf.interval > 0:
            frame_interval = sf.interval  # adopt the decoder's REAL interval
        for zi, (zx, zy, zw, zh) in enumerate(zones):
            crop = sf.image[zy:zy + zh, zx:zx + zw]
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            mask = text_mask(gray)
            fg = float(np.count_nonzero(mask)) / max(1, mask.size)

            if fg < _MIN_FG_RATIO or text_presence(gray) < presence_thr:
                lines = []  # no text-like content → skip OCR (avoids hallucinations)
                grp_best[zi], grp_ocr[zi] = 0.0, 0
            else:
                changed = prev_mask[zi] is None or mask_diff_ratio(mask, prev_mask[zi]) >= change_thr
                if changed:
                    lines = _ocr(crop, mask)
                    grp_best[zi], grp_ocr[zi] = focus_measure(gray), 1
                else:
                    sharp = focus_measure(gray)
                    if best_frame and grp_ocr[zi] < max_ocr_grp and sharp > grp_best[zi] * (1.0 + best_margin):
                        # A crisper frame of the same subtitle → re-OCR it; the new
                        # reading joins the consensus vote for this cue.
                        lines = _ocr(crop, mask)
                        grp_best[zi], grp_ocr[zi] = max(grp_best[zi], sharp), grp_ocr[zi] + 1
                    else:
                        lines = prev_lines[zi]  # text unchanged → reuse last reading
            prev_mask[zi], prev_lines[zi] = mask, lines

            good = [l for l in lines if l.confidence >= min_conf and l.text.strip()]
            text = _order_text(good)
            conf = (sum(l.confidence for l in good) / len(good)) if good else 1.0
            samples[zi].append((sf.timestamp, text, zone_an[zi], conf))

        now = time.monotonic()
        if on_progress and (i % _PROGRESS_EVERY == 0 or now - last_poll >= _PROGRESS_SECS):
            on_progress(i, est_total)
            last_poll = now

    cues: list[Cue] = []
    for zi in range(len(zones)):
        cues.extend(
            merge_into_cues(
                samples[zi],
                frame_interval=frame_interval,
                min_duration=float(cfg.get("min_subtitle_duration", 0.4)),
                min_frames=int(cfg.get("min_frames", 2)),
                min_gap=float(cfg.get("min_gap", 1.0)),
                drop_junk=bool(cfg.get("drop_junk", True)),
                char_voting=bool(cfg.get("char_voting", True)),
            )
        )
    cues.sort(key=lambda c: c.start)
    # Latin job → drop foreign-script hallucinations (e.g. a VLM emitting CJK).
    if cfg.get("drop_foreign_script", True) and cfg.get("rec_lang") == "latin":
        cues = [c for c in cues if non_latin_ratio(c.text) <= 0.4]
    return cues, info


def process_job(cfg: Config, client: APIClient, job: dict[str, Any], input_url: str,
                wcfg: dict | None = None, substitution_rules: list | None = None) -> None:
    job_id = job["id"]
    params = _as_dict(job.get("params"))
    rcfg = resolve_config(params, wcfg or {})
    language = rcfg["language"]
    formats = params.get("formats") or ["srt", "ass"]

    with tempfile.TemporaryDirectory(prefix="subext-") as tmp:
        video_path = os.path.join(tmp, job.get("sourceFilename") or "input.bin")

        client.progress(job_id, 2, "downloading", log="downloading input video")
        client.download(input_url, video_path)

        client.progress(job_id, 6, "loading_model", log=f"loading OCR backend: {rcfg['backend']}")
        backend = build_backend(rcfg)

        # Liveness: a background timer pings the job heartbeat so the API sees a
        # long-running job as alive even between progress posts. Stopped in the
        # `finally` below so it never outlives the job.
        hb_stop = threading.Event()

        def _heartbeat_loop() -> None:
            while not hb_stop.wait(10.0):
                try:
                    client.heartbeat(job_id)
                except Exception:  # noqa: BLE001
                    pass  # transient; the next tick (or progress poll) retries

        hb_thread = threading.Thread(target=_heartbeat_loop, daemon=True)
        hb_thread.start()

        # Progress posts double as the cancellation signal (a 409 raises
        # JobCanceled inside client.progress), so OCR aborts within a few seconds.
        def _on_progress(i: int, est_total: int) -> None:
            pct = 6 + int(min(80, (i / est_total) * 80))
            client.progress(job_id, pct, "ocr", log=f"frame {i}/{est_total}")

        try:
            cues, info = extract_cues(
                video_path, backend, rcfg,
                on_progress=_on_progress,
                log=lambda m: client.log(job_id, m),
            )
        finally:
            hb_stop.set()
            hb_thread.join(timeout=2.0)

        # Honor a cancel that arrives during/just before merge+upload.
        client.progress(job_id, 88, "merging", log="merging frames into cues")  # 409 → JobCanceled
        if substitution_rules:
            apply_substitution_rules(cues, substitution_rules, language)
            client.log(job_id, f"applied {len(substitution_rules)} substitution rule(s)")
        client.log(job_id, f"produced {len(cues)} subtitle cues")
        if not cues:
            client.log(job_id, "no subtitles detected", level="warn")

        # Final cancel checkpoint before we write + upload results (409 → JobCanceled).
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
