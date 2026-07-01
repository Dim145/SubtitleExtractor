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
from .normalize_fr import get_french_words, is_french, normalize_line
from .video import VideoInfo, probe, sample_frames_auto

# Built-in fallbacks when neither the job nor the worker config specify a value.
DEFAULT_FPS = 4.0
# Lower per-line confidence floor: recall first, then precision via post-filters.
DEFAULT_MIN_CONFIDENCE = 0.4
DEFAULT_BACKEND = "rapidocr"

# Single source of truth for merge/OCR-loop knob defaults so `resolve_config`
# and the `extract_cues` / `merge_into_cues` fallbacks cannot drift apart.
DEFAULT_UPSCALE = 2.0
DEFAULT_TARGET_TEXT_HEIGHT = 40.0
DEFAULT_MAX_SCALE = 4.0
DEFAULT_TEXT_PRESENCE_THRESHOLD = 0.008
DEFAULT_CHANGE_THRESHOLD = 0.01
DEFAULT_PRESENCE_CHANGE_THRESHOLD = 0.15
DEFAULT_BEST_FRAME = False
DEFAULT_BEST_FRAME_MARGIN = 0.15
DEFAULT_MAX_OCR_PER_GROUP = 2
DEFAULT_MIN_FRAMES = 2
DEFAULT_MIN_SUBTITLE_DURATION = 0.4
DEFAULT_MIN_GAP = 1.0
DEFAULT_SIM_THRESHOLD = 80.0
DEFAULT_DROP_JUNK = True
DEFAULT_CHAR_VOTING = True
# Permanent-overlay filter: a cue must be both long (absolute) AND span most of
# the video to be treated as a station-ID/watermark overlay rather than a cue.
DEFAULT_PERMANENT_MIN_SECONDS = 12.0
DEFAULT_PERMANENT_MIN_FRACTION = 0.8
# A real burned-in subtitle / song lyric spans much of the frame width; a
# watermark/logo is narrow and corner-placed. So a long cue is only treated as a
# permanent overlay when its horizontal extent (w_frac, normalized to zone width)
# is BELOW this threshold. A long cue that spans most of the width is kept.
PERMANENT_MIN_WIDTH_FRAC = 0.5


def is_permanent_overlay(
    cue: "Cue",
    duration: float,
    perm_secs: float = DEFAULT_PERMANENT_MIN_SECONDS,
    perm_frac: float = DEFAULT_PERMANENT_MIN_FRACTION,
    width_frac: float = PERMANENT_MIN_WIDTH_FRAC,
) -> bool:
    """True if a cue looks like a permanent watermark/logo/station-ID overlay
    rather than a real subtitle, and should be dropped.

    A cue is flagged only when it is BOTH long in absolute terms (> ``perm_secs``)
    AND covers most of the clip's runtime (> ``perm_frac`` * ``duration``) AND is
    NARROW — its horizontal extent ``w_frac`` (normalized to the zone width) is
    below ``width_frac``. A long cue that spans a near-full-frame width is a real
    subtitle / song lyric and is KEPT.

    Graceful degradation: when box geometry is unavailable (the ``w_frac == 0.0``
    sentinel, e.g. a VLM backend returning no boxes), fall back to the duration-only
    behavior for that cue — flag it if and only if it is long, as before."""
    dur = cue.end - cue.start
    if not (dur > perm_secs and dur > perm_frac * duration):
        return False  # not long enough → keep
    if cue.w_frac <= 0.0:
        return True  # no geometry → duration-only fallback (long ⇒ permanent)
    return cue.w_frac < width_frac  # long: drop only when narrow

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
        # Auto-detect the subtitle band(s) via DBNet when set and no explicit
        # zones are given; otherwise fall back to the fixed bottom band.
        "auto_zone": bool(_pick(params, wcfg, "auto_zone", False)),
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
        "upscale": float(_pick(params, wcfg, "upscale", DEFAULT_UPSCALE)),
        "target_text_height": float(_pick(params, wcfg, "target_text_height", DEFAULT_TARGET_TEXT_HEIGHT)),
        "max_scale": float(_pick(params, wcfg, "max_scale", DEFAULT_MAX_SCALE)),
        # Gating + merge.
        # DBNet detector as the presence gate (recall win over edge density: it
        # catches faint / short cues the edge heuristic misses). When off, fall
        # back to the edge-density gate below.
        "use_detector_gate": bool(_pick(params, wcfg, "use_detector_gate", True)),
        # limit_type="max" keeps det ~25ms on wide-short subtitle bands ("min"
        # upscales the short side and explodes the wide side to 400-600ms).
        "detector_limit_type": _pick(params, wcfg, "detector_limit_type", "max"),
        "detector_limit_side_len": int(_pick(params, wcfg, "detector_limit_side_len", 736)),
        "text_presence_threshold": float(_pick(params, wcfg, "text_presence_threshold", DEFAULT_TEXT_PRESENCE_THRESHOLD)),
        "change_threshold": float(_pick(params, wcfg, "change_threshold", DEFAULT_CHANGE_THRESHOLD)),
        # Also re-OCR when text-edge density (presence) jumps by this relative
        # amount — the bright-pixel mask alone misses a short word appearing over
        # a busy/bright background (it barely moves the mask). Catches short cues.
        "presence_change_threshold": float(_pick(params, wcfg, "presence_change_threshold", DEFAULT_PRESENCE_CHANGE_THRESHOLD)),
        "min_frames": int(_pick(params, wcfg, "min_frames", DEFAULT_MIN_FRAMES)),
        "min_subtitle_duration": float(_pick(params, wcfg, "min_subtitle_duration", DEFAULT_MIN_SUBTITLE_DURATION)),
        # Max gap to bridge two near-identical consecutive cues into one. A single
        # subtitle often splits across a brief (~0.5s) detection dropout; 0.4 was
        # too tight and left duplicates. sim_threshold still guards against merging
        # genuinely different lines.
        "min_gap": float(_pick(params, wcfg, "min_gap", DEFAULT_MIN_GAP)),
        # Fuzzy-match floor (0..100) for grouping/bridging near-identical cue text.
        "sim_threshold": float(_pick(params, wcfg, "sim_threshold", DEFAULT_SIM_THRESHOLD)),
        "drop_junk": bool(_pick(params, wcfg, "drop_junk", DEFAULT_DROP_JUNK)),
        "char_voting": bool(_pick(params, wcfg, "char_voting", DEFAULT_CHAR_VOTING)),
        # French-only deterministic post-OCR normalizer (restore elision
        # apostrophes, split run-together words). Wordlist-validated → no
        # regressions; applied only to French jobs. See normalize_fr.py.
        "normalize_text": bool(_pick(params, wcfg, "normalize_text", True)),
        # Drop cues whose script doesn't match a Latin job (VLM CJK hallucinations).
        "drop_foreign_script": bool(_pick(params, wcfg, "drop_foreign_script", True)),
        # Drop cues spanning most of the video — permanent overlays (watermark/
        # logo), never real subtitles. Guards auto-zone + wide manual zones.
        "drop_permanent": bool(_pick(params, wcfg, "drop_permanent", True)),
        # Best-frame re-OCR within a stable group (sharper frame → better read).
        # Off by default: it roughly triples OCR cost and its accuracy benefit is
        # unproven on this content — enable + measure with the eval harness before
        # turning it on for real.
        "best_frame": bool(_pick(params, wcfg, "best_frame", DEFAULT_BEST_FRAME)),
        "best_frame_margin": float(_pick(params, wcfg, "best_frame_margin", DEFAULT_BEST_FRAME_MARGIN)),
        "max_ocr_per_group": int(_pick(params, wcfg, "max_ocr_per_group", DEFAULT_MAX_OCR_PER_GROUP)),
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


def auto_detect_zones(video_path: str, info: VideoInfo, cfg: dict) -> list[dict] | None:
    """Discover the subtitle band(s) by running the DBNet detector on a sparse
    set of FULL frames and clustering the detected boxes into horizontal bands.

    Samples ~1 frame every 3s (capped at ~15), runs the detector on each full
    frame, collects every box's normalized y-center / height / x-extent, then
    does a lightweight 1D clustering on y-centers (tolerance ~ median box
    height). Clusters supported by a reasonable fraction of sampled frames are
    kept (densest bottom band + optionally a top band, max 2) and emitted as
    normalized zone dicts {x, y, w, h} spanning the cluster's x-extent (with a
    small horizontal margin) and y-band (with vertical padding).

    Returns None when nothing solid is found (caller falls back to the default
    bottom band)."""
    from .backends.detector import get_detector

    W, H = info.width, info.height
    if W <= 0 or H <= 0:
        return None

    # Sparse sampling: ~one frame every 3s, at least a few, capped so this stays
    # a quick pre-pass (full-frame det is ~25ms with limit_type="max").
    duration = max(1.0, info.duration)
    n_samples = int(min(15, max(4, duration / 3.0)))
    sample_fps = n_samples / duration

    detector = get_detector(
        ocr_version=cfg.get("ocr_version") or "PP-OCRv5",
        det_model_type=cfg.get("det_model_type") or "mobile",
        limit_type=cfg.get("detector_limit_type") or "max",
        limit_side_len=int(cfg.get("detector_limit_side_len", 736)),
    )

    # Each detected box → normalized (y_center, height, x1, x2).
    boxes: list[tuple[float, float, float, float]] = []
    n_frames = 0
    for sf in sample_frames_auto(video_path, sample_fps, cfg.get("decoder"), cfg.get("hwaccel")):
        n_frames += 1
        for (x1, y1, x2, y2) in detector.detect_boxes(sf.image):
            if x2 <= x1 or y2 <= y1:
                continue
            yc = ((y1 + y2) / 2.0) / H
            bh = (y2 - y1) / H
            boxes.append((yc, bh, x1 / W, x2 / W))
        if n_frames >= n_samples + 2:  # guard against fps rounding overshoot
            break

    if n_frames == 0 or not boxes:
        return None

    # 1D clustering on y-centers: sort, then greedily group neighbors within a
    # tolerance derived from the median box height.
    boxes.sort(key=lambda b: b[0])
    heights = sorted(b[1] for b in boxes)
    med_h = heights[len(heights) // 2] or 0.02
    tol = max(med_h, 0.02)

    clusters: list[list[tuple[float, float, float, float]]] = []
    cur: list[tuple[float, float, float, float]] = []
    last_yc = None
    for b in boxes:
        if last_yc is None or (b[0] - last_yc) <= tol:
            cur.append(b)
        else:
            clusters.append(cur)
            cur = [b]
        last_yc = b[0]
    if cur:
        clusters.append(cur)

    # Keep clusters supported by a reasonable fraction of sampled frames. A band
    # is only "real" if it recurs across the clip, not a one-off caption.
    min_support = max(2, int(round(0.2 * n_frames)))
    kept = [c for c in clusters if len(c) >= min_support]
    if not kept:
        return None

    # Prefer the densest bands; keep at most 2 (typically a bottom band, plus an
    # optional second band such as a top caption).
    kept.sort(key=lambda c: len(c), reverse=True)
    kept = kept[:2]

    zones: list[dict] = []
    for c in kept:
        ycs = [b[0] for b in c]
        bhs = [b[1] for b in c]
        x1s = [b[2] for b in c]
        x2s = [b[3] for b in c]
        band_h = max(bhs)
        y_top = min(ycs) - band_h / 2.0
        y_bot = max(ycs) + band_h / 2.0
        # Vertical padding so cropping doesn't clip ascenders/descenders / a
        # second wrapped line of the same subtitle.
        pad_v = max(band_h, 0.04)
        y = max(0.0, y_top - pad_v)
        h = min(1.0 - y, (y_bot - y_top) + 2 * pad_v)
        # Horizontal extent with a small margin.
        x = max(0.0, min(x1s) - 0.02)
        w = min(1.0 - x, (max(x2s) - min(x1s)) + 0.04)
        if h <= 0 or w <= 0:
            continue
        zones.append({"x": round(x, 4), "y": round(y, 4), "w": round(w, 4), "h": round(h, 4)})

    # Order top→bottom for stable/readable logging + zone indices.
    zones.sort(key=lambda z: z["y"])
    return zones or None


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
    upscale = float(cfg.get("upscale", DEFAULT_UPSCALE))
    target_h = float(cfg.get("target_text_height", DEFAULT_TARGET_TEXT_HEIGHT))
    max_scale = float(cfg.get("max_scale", DEFAULT_MAX_SCALE))
    presence_thr = float(cfg.get("text_presence_threshold", DEFAULT_TEXT_PRESENCE_THRESHOLD))
    change_thr = float(cfg.get("change_threshold", DEFAULT_CHANGE_THRESHOLD))
    best_frame = bool(cfg.get("best_frame", DEFAULT_BEST_FRAME))
    best_margin = float(cfg.get("best_frame_margin", DEFAULT_BEST_FRAME_MARGIN))
    max_ocr_grp = int(cfg.get("max_ocr_per_group", DEFAULT_MAX_OCR_PER_GROUP))
    pres_change_thr = float(cfg.get("presence_change_threshold", DEFAULT_PRESENCE_CHANGE_THRESHOLD))

    # Presence gate: a DBNet detector (recall win) or the edge-density heuristic.
    use_det_gate = bool(cfg.get("use_detector_gate", True))
    detector = None
    if use_det_gate:
        from .backends.detector import get_detector

        detector = get_detector(
            ocr_version=cfg.get("ocr_version") or "PP-OCRv5",
            det_model_type=cfg.get("det_model_type") or "mobile",
            limit_type=cfg.get("detector_limit_type") or "max",
            limit_side_len=int(cfg.get("detector_limit_side_len", 736)),
        )

    def _ocr(crop: np.ndarray, mask: np.ndarray) -> tuple[list, int]:
        """OCR a crop, scaling it toward the target glyph height (capped).

        Returns (lines, ocr_width) where ocr_width is the pixel width of the image
        actually fed to the recognizer. Line bboxes are in that image's coords, so
        dividing an x by ocr_width yields a fraction of the ZONE width (scale
        cancels out), which is what the horizontal-extent plumbing needs."""
        scale = min(max_scale, upscale)  # fallback when height can't be estimated
        if target_h > 0:
            th = estimate_text_height(mask)
            if th > 0:
                scale = max(1.0, min(max_scale, target_h / th))
        img = crop
        if scale > 1.01:
            img = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        return backend.recognize(img), int(img.shape[1])

    info = probe(video_path)
    # Auto-zone: when enabled and no explicit zones were given, discover the
    # subtitle band(s) via DBNet; on success feed them through the same
    # _resolve_zones path as explicit zones, else fall back to the default band.
    zone_spec = cfg.get("zones")
    if cfg.get("auto_zone") and not zone_spec:
        detected = auto_detect_zones(video_path, info, cfg)
        if detected:
            zone_spec = detected
            if log:
                bands = ", ".join(
                    f"y={z['y']:.2f}-{z['y'] + z['h']:.2f}" for z in detected
                )
                log(f"auto-zone: {len(detected)} band(s) at {bands}")
        elif log:
            log("auto-zone: fell back to default band")
    zones = _resolve_zones(zone_spec, info.width, info.height)
    frame_interval = 1.0 / sample_fps  # replaced by the decoder's REAL interval below
    # Progress estimate. The decoder may sample at a slightly different rate than
    # the nominal sample_fps (e.g. OpenCV steps whole source frames), so once the
    # first frame reports the REAL interval we recompute est_total from it — this
    # keeps the "frame i/est_total" log honest instead of e.g. "900/720".
    est_total = max(1, int(info.duration * sample_fps))
    if log:
        log(f"video {info.width}x{info.height} @ {info.fps:.2f}fps, ~{info.duration:.0f}s, {len(zones)} zone(s)")

    # Per-zone frame samples: (timestamp, text, alignment, confidence, extent),
    # where extent is (x_frac, w_frac) normalized to the zone width or None when
    # no box geometry is available for that frame.
    samples: list[list[tuple]] = [[] for _ in zones]
    zone_an = [alignment_from_bbox((0, 0, zw, zh), info.width, info.height, zx, zy)
               for (zx, zy, zw, zh) in zones]
    prev_mask: list[Any] = [None for _ in zones]
    prev_lines: list[list] = [[] for _ in zones]
    prev_ocr_w: list[int] = [0 for _ in zones]  # width of last OCR'd image, for x-extent norm
    prev_pres: list[float] = [0.0 for _ in zones]  # last text-presence, for delta trigger
    grp_best: list[float] = [0.0 for _ in zones]   # best sharpness in current group
    grp_ocr: list[int] = [0 for _ in zones]         # OCR calls spent on current group

    last_poll = time.monotonic()
    for i, sf in enumerate(sample_frames_auto(video_path, sample_fps, cfg.get("decoder"), cfg.get("hwaccel"))):
        if i == 0 and sf.interval > 0:
            frame_interval = sf.interval  # adopt the decoder's REAL interval
            # Recompute the progress denominator from the REAL sampling rate so
            # the frame counter can't overshoot (e.g. "900/720").
            est_total = max(1, int(info.duration / frame_interval))
        # Actual decoded frame dims can differ from the probe (rotation, SAR,
        # decoder quirks); clamp each zone against THIS frame's shape per-frame.
        fh, fw = sf.image.shape[:2]
        for zi, (zx0, zy0, zw0, zh0) in enumerate(zones):
            zx = max(0, min(zx0, fw - 1))
            zy = max(0, min(zy0, fh - 1))
            zw = max(1, min(zw0, fw - zx))
            zh = max(1, min(zh0, fh - zy))
            crop = sf.image[zy:zy + zh, zx:zx + zw]
            if crop.size == 0:
                # Degenerate crop (zone fully outside this frame) — treat as no
                # text and skip OCR rather than letting cvtColor/text_mask raise.
                lines = []
                grp_best[zi], grp_ocr[zi] = 0.0, 0
                prev_mask[zi], prev_lines[zi], prev_pres[zi] = None, lines, 0.0
                prev_ocr_w[zi] = 0
                samples[zi].append((sf.timestamp, "", zone_an[zi], 0.0, None))
                continue
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            mask = text_mask(gray)
            fg = float(np.count_nonzero(mask)) / max(1, mask.size)
            # text_presence is still needed by the change-detection presence-delta
            # trigger below, so compute it regardless of which gate is active.
            pres = text_presence(gray)

            # Presence gate. Detector: text present iff DBNet finds >=1 box (proper
            # recall on faint/short cues). Fallback: the edge-density heuristic.
            if detector is not None:
                present = detector.detect(crop) >= 1
            else:
                present = not (fg < _MIN_FG_RATIO or pres < presence_thr)

            if not present:
                lines = []  # no text-like content → skip OCR (avoids hallucinations)
                ocr_w = 0
                grp_best[zi], grp_ocr[zi] = 0.0, 0
            else:
                # A short word appearing over a bright/busy background barely moves
                # the bright-pixel mask, so also trigger on a relative jump in
                # text-edge density (presence) — otherwise short cues are missed.
                ppres = prev_pres[zi]
                changed = (
                    prev_mask[zi] is None
                    or mask_diff_ratio(mask, prev_mask[zi]) >= change_thr
                    or (ppres > 0 and abs(pres - ppres) / ppres >= pres_change_thr)
                )
                if changed:
                    lines, ocr_w = _ocr(crop, mask)
                    grp_best[zi], grp_ocr[zi] = focus_measure(gray), 1
                else:
                    sharp = focus_measure(gray)
                    if best_frame and grp_ocr[zi] < max_ocr_grp and sharp > grp_best[zi] * (1.0 + best_margin):
                        # A crisper frame of the same subtitle → re-OCR it; the new
                        # reading joins the consensus vote for this cue.
                        lines, ocr_w = _ocr(crop, mask)
                        grp_best[zi], grp_ocr[zi] = max(grp_best[zi], sharp), grp_ocr[zi] + 1
                    else:
                        lines = prev_lines[zi]  # text unchanged → reuse last reading
                        ocr_w = prev_ocr_w[zi]
            prev_mask[zi], prev_lines[zi], prev_pres[zi] = mask, lines, pres
            prev_ocr_w[zi] = ocr_w

            good = [l for l in lines if l.confidence >= min_conf and l.text.strip()]
            text = _order_text(good)
            # Empty reads carry no confidence signal — use 0.0 so they don't
            # inflate a cue's mean confidence in the vote.
            conf = (sum(l.confidence for l in good) / len(good)) if good else 0.0
            # Horizontal extent (x_frac, w_frac) of this frame's text, normalized to
            # the ZONE width. bbox x-coords are in the OCR'd image's frame and ocr_w
            # is that image's width, so scale cancels. None when there's no geometry
            # (no good lines or the backend reported a zero-width bbox), which the
            # merger treats as "no geometry" and the permanent filter falls back on.
            extent = None
            if good and ocr_w > 0:
                xs0 = [l.bbox[0] for l in good]
                xs1 = [l.bbox[2] for l in good]
                x_min = max(0.0, min(xs0) / ocr_w)
                x_max = min(1.0, max(xs1) / ocr_w)
                if x_max > x_min:
                    extent = (x_min, x_max - x_min)
            samples[zi].append((sf.timestamp, text, zone_an[zi], conf, extent))

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
                sim_threshold=float(cfg.get("sim_threshold", DEFAULT_SIM_THRESHOLD)),
                min_duration=float(cfg.get("min_subtitle_duration", DEFAULT_MIN_SUBTITLE_DURATION)),
                min_frames=int(cfg.get("min_frames", DEFAULT_MIN_FRAMES)),
                min_gap=float(cfg.get("min_gap", DEFAULT_MIN_GAP)),
                drop_junk=bool(cfg.get("drop_junk", DEFAULT_DROP_JUNK)),
                char_voting=bool(cfg.get("char_voting", DEFAULT_CHAR_VOTING)),
            )
        )
    cues.sort(key=lambda c: c.start)
    # Latin job → drop foreign-script hallucinations (e.g. a VLM emitting CJK).
    if cfg.get("drop_foreign_script", True) and cfg.get("rec_lang") == "latin":
        cues = [c for c in cues if non_latin_ratio(c.text) <= 0.4]
    # Drop permanent overlays (watermark/logo/station ID): a real subtitle never
    # spans most of the video. Catches e.g. a "HentaiVOST.FR" watermark that
    # auto-zone clustering or a wide manual zone picks up as one long cue.
    if cfg.get("drop_permanent", True) and info.duration > 0:
        # A real subtitle can legitimately run long on a short clip, so a long
        # duration alone false-dropped genuine long cues. Drop a cue as a permanent
        # overlay only when it is BOTH long in absolute terms AND covers most of the
        # clip's runtime AND is NARROW (does not span a near-full-frame width). A
        # long cue that spans most of the width is a real subtitle / song lyric and
        # is KEPT. When box geometry is unavailable (w_frac == 0.0 sentinel, e.g. a
        # VLM backend that returns no boxes) we fall back to the duration-only test
        # so we neither crash nor over-drop.
        perm_secs = float(cfg.get("permanent_min_seconds", DEFAULT_PERMANENT_MIN_SECONDS))
        perm_frac = float(cfg.get("permanent_min_fraction", DEFAULT_PERMANENT_MIN_FRACTION))
        width_frac = float(cfg.get("permanent_min_width_fraction", PERMANENT_MIN_WIDTH_FRAC))
        cues = [
            c for c in cues
            if not is_permanent_overlay(c, info.duration, perm_secs, perm_frac, width_frac)
        ]
    # French-only deterministic normalizer: restore elision apostrophes and
    # split run-together words the OCR recognizer glued (wordlist-validated, so
    # it never rewrites valid words or introduces regressions).
    if cfg.get("normalize_text", True) and is_french(cfg.get("language")):
        words = get_french_words()
        if words:
            for c in cues:
                c.text = normalize_line(c.text, words)
    return cues, info


def process_job(cfg: Config, client: APIClient, job: dict[str, Any], input_url: str,
                wcfg: dict | None = None, substitution_rules: list | None = None) -> None:
    job_id = job["id"]
    params = _as_dict(job.get("params"))
    rcfg = resolve_config(params, wcfg or {})
    language = rcfg["language"]
    formats = params.get("formats") or ["srt", "ass"]

    with tempfile.TemporaryDirectory(prefix="subext-") as tmp:
        # Defense-in-depth: never let a server-supplied filename escape the
        # tempdir (path traversal). Keep only the extension of the reported name
        # and write to a fixed "input" basename inside `tmp`.
        ext = os.path.splitext(os.path.basename(job.get("sourceFilename") or ""))[1]
        if len(ext) > 10 or any(c in ext for c in ("/", "\\", "\x00")):
            ext = ""  # implausible/hostile extension → drop it
        video_path = os.path.join(tmp, "input" + (ext or ".bin"))

        # Point backends' per-call temp files (e.g. the PaddleOCR-VL PNG) inside
        # this job dir so the TemporaryDirectory cleanup covers them and they
        # don't leak on SIGKILL. Restored after the job.
        prev_tmp_dir = os.environ.get("SUBEXT_TMP_DIR")
        os.environ["SUBEXT_TMP_DIR"] = tmp
        try:
            _run_job_body(cfg, client, job, job_id, params, rcfg, language, formats,
                          video_path, input_url, tmp, substitution_rules)
        finally:
            if prev_tmp_dir is None:
                os.environ.pop("SUBEXT_TMP_DIR", None)
            else:
                os.environ["SUBEXT_TMP_DIR"] = prev_tmp_dir


def _run_job_body(cfg, client, job, job_id, params, rcfg, language, formats,
                  video_path, input_url, tmp, substitution_rules) -> None:
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
