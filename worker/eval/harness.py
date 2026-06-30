#!/usr/bin/env python3
"""Subtitle-OCR evaluation harness for the SubtitleExtractor worker.

Runs the worker's real extraction pipeline (`subextractor.pipeline.extract_cues`)
against short test clips under one or more named config *presets*, so you can:

  * eyeball how cue text / counts / timings differ between presets
    (``differential`` mode), and
  * score a preset's output against a hand-checked ground-truth transcript with
    Character- and Word-Error-Rate (``score`` mode).

This is a *technical OCR evaluation* tool: it only ever handles the extracted
subtitle TEXT and numeric metrics. It never renders, screenshots or describes
video imagery.

Run it from the ``worker/`` directory with the project venv so ``import
subextractor`` resolves, e.g.::

    cd worker
    .venv/bin/python eval/harness.py differential --clip /path/clip_a.mkv \
        --presets current,fast

See ``eval/README.md`` for the full workflow (scan -> cut -> differential ->
make-gt -> score).
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from rapidfuzz.distance import Levenshtein

# Make `import subextractor` work even when the script is launched by absolute
# path from outside the worker/ dir (the package lives one level up).
_WORKER_DIR = Path(__file__).resolve().parent.parent
if str(_WORKER_DIR) not in sys.path:
    sys.path.insert(0, str(_WORKER_DIR))

from subextractor import pipeline  # noqa: E402
from subextractor.dedup import text_mask, text_presence  # noqa: E402
from subextractor.video import probe, sample_frames  # noqa: E402

# Default location for cut clips: OUTSIDE the repo so large / adult media is
# never staged or committed. Overridable with --clips-dir.
DEFAULT_CLIPS_DIR = (
    "/private/tmp/claude-501/-Users-dim145-IdeaProjects-SubtitleExtractor/"
    "6ed59b06-45d9-40e1-bb87-b4d82baef272/scratchpad"
)

_EVAL_DIR = Path(__file__).resolve().parent
_GROUNDTRUTH_DIR = _EVAL_DIR / "groundtruth"
_REPORT_PATH = _EVAL_DIR / "report.md"


# --------------------------------------------------------------------------- #
# Presets
# --------------------------------------------------------------------------- #
# A preset is just a dict of overrides merged on top of the resolved default
# config. `current` ({}) exercises the new defaults; the others probe specific
# trade-offs (speed, older model family).
PRESETS: dict[str, dict[str, Any]] = {
    "current": {},
    "fast": {"best_frame": False, "det_limit_side_len": 736},
    "v4": {"ocr_version": "PP-OCRv4"},
}


def build_cfg(preset_name: str, language: str) -> dict[str, Any]:
    """Resolve the default config for `language`, then merge a preset over it."""
    if preset_name not in PRESETS:
        raise KeyError(
            f"unknown preset {preset_name!r}; choose from {', '.join(PRESETS)}"
        )
    cfg = pipeline.resolve_config({"language": language}, {})
    cfg.update(PRESETS[preset_name])
    return cfg


# --------------------------------------------------------------------------- #
# Clip helper
# --------------------------------------------------------------------------- #
def cut_clip(src: str, start: float, dur: float, out: str) -> str:
    """Cut a ``dur``-second clip from ``src`` starting at ``start`` (seconds).

    Uses stream copy (``-c copy``) for a fast, lossless cut. Returns ``out``.
    Raises ``RuntimeError`` if ffmpeg fails or produces no output.
    """
    import subprocess

    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-ss", str(start), "-i", src, "-t", str(dur), "-c", "copy", out,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 or not os.path.exists(out) or os.path.getsize(out) == 0:
        raise RuntimeError(
            f"ffmpeg cut failed (rc={res.returncode}): {res.stderr.strip()}"
        )
    return out


# --------------------------------------------------------------------------- #
# Scan: find subtitle-dense windows
# --------------------------------------------------------------------------- #
def _bottom_band(image: np.ndarray) -> np.ndarray:
    """Grayscale crop of the bottom ~38% band where burned-in subs usually sit."""
    h = image.shape[0]
    y = int(h * 0.62)
    crop = image[y:, :]
    return cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)


def scan_source(src: str, top_n: int, window: float, sample_fps: float = 1.0) -> None:
    """Sample ``src`` at ~``sample_fps`` and print the ``top_n`` densest windows.

    For each sampled frame we measure bottom-band text presence
    (``text_mask`` foreground ratio gated by ``text_presence``); per-second
    scores are aggregated into non-overlapping ``window``-second buckets and the
    densest buckets are printed as ``(start, score)`` to pick clip offsets.
    """
    info = probe(src)
    print(f"scanning {os.path.basename(src)}  "
          f"{info.width}x{info.height} @ {info.fps:.2f}fps  ~{info.duration:.0f}s")

    # Per-frame (timestamp, density) where density = foreground ratio of the
    # text mask, zeroed when edge-based presence is below the pipeline threshold.
    presence_thr = 0.008
    samples: list[tuple[float, float]] = []
    for sf in sample_frames(src, sample_fps):
        gray = _bottom_band(sf.image)
        if gray.size == 0:
            samples.append((sf.timestamp, 0.0))
            continue
        if text_presence(gray) < presence_thr:
            density = 0.0
        else:
            mask = text_mask(gray)
            density = float(np.count_nonzero(mask)) / max(1, mask.size)
        samples.append((sf.timestamp, density))

    if not samples:
        print("  no frames sampled")
        return

    # Bucket into non-overlapping windows; score = mean density over the bucket.
    buckets: dict[int, list[float]] = {}
    for ts, density in samples:
        buckets.setdefault(int(ts // window), []).append(density)
    ranked = sorted(
        ((b * window, sum(v) / len(v)) for b, v in buckets.items()),
        key=lambda t: t[1],
        reverse=True,
    )

    print(f"  densest {top_n} window(s) of {window:.0f}s "
          f"(start_s, density score; higher = more subtitle text):")
    for start, score in ranked[:top_n]:
        print(f"    --start {start:7.1f} --dur {window:.0f}   score={score:.4f}")


# --------------------------------------------------------------------------- #
# Running presets on a clip
# --------------------------------------------------------------------------- #
@dataclass
class PresetResult:
    """One preset's output on one clip."""

    preset: str
    n_cues: int
    wall_s: float
    cues: list[Any] = field(default_factory=list)  # list[subextractor.dedup.Cue]


def run_preset(clip: str, preset: str, language: str) -> PresetResult:
    """Run a single preset over ``clip`` and return cues + timing."""
    cfg = build_cfg(preset, language)
    backend = pipeline.build_backend(cfg)
    t0 = time.monotonic()
    cues, _info = pipeline.extract_cues(clip, backend, cfg)
    wall = time.monotonic() - t0
    return PresetResult(preset=preset, n_cues=len(cues), wall_s=wall, cues=cues)


def _fmt_cue(cue: Any) -> str:
    """One-line ``start->end | conf | text`` (newlines in text shown as '/')."""
    text = cue.text.replace("\n", " / ")
    return f"  {cue.start:7.2f}->{cue.end:7.2f} | {cue.confidence:4.2f} | {text}"


# --------------------------------------------------------------------------- #
# Scoring (CER / WER)
# --------------------------------------------------------------------------- #
def _normalize_chars(text: str) -> str:
    """Flatten transcript to a single normalized string for CER.

    Strip each line, lowercase, collapse internal whitespace, drop empty lines,
    join the rest with '\\n'.
    """
    lines = []
    for line in text.replace("\r\n", "\n").split("\n"):
        collapsed = " ".join(line.strip().lower().split())
        if collapsed:
            lines.append(collapsed)
    return "\n".join(lines)


def _tokens(text: str) -> list[str]:
    """Whitespace token list of the normalized transcript for WER."""
    return _normalize_chars(text).split()


def cer(reference: str, hypothesis: str) -> float:
    """Character Error Rate = edit_distance(ref, hyp) / len(ref_chars)."""
    ref = _normalize_chars(reference)
    hyp = _normalize_chars(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    return Levenshtein.distance(ref, hyp) / len(ref)


def wer(reference: str, hypothesis: str) -> float:
    """Word Error Rate = token_edit_distance / len(ref_tokens)."""
    ref = _tokens(reference)
    hyp = _tokens(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    return Levenshtein.distance(ref, hyp) / len(ref)


def cues_to_transcript(cues: list[Any]) -> str:
    """Join cue texts, one cue per line (newlines within a cue preserved)."""
    return "\n".join(c.text for c in cues)


def groundtruth_path(clip: str) -> Path:
    """Reference path ``eval/groundtruth/<clip-stem>.txt`` for a clip."""
    return _GROUNDTRUTH_DIR / f"{Path(clip).stem}.txt"


# --------------------------------------------------------------------------- #
# Modes
# --------------------------------------------------------------------------- #
def mode_differential(
    clips: list[str], presets: list[str], language: str
) -> list[str]:
    """Run every preset on every clip, printing a per-clip comparison table.

    Returns markdown report lines for the written report.
    """
    md: list[str] = ["## Differential\n"]
    for clip in clips:
        header = f"clip: {os.path.basename(clip)}"
        print("\n" + "=" * len(header))
        print(header)
        print("=" * len(header))
        md.append(f"### {os.path.basename(clip)}\n")

        results: list[PresetResult] = []
        for preset in presets:
            print(f"\n-- preset: {preset}  (overrides: {PRESETS[preset] or '{}'})")
            res = run_preset(clip, preset, language)
            results.append(res)
            print(f"   {res.n_cues} cues in {res.wall_s:.1f}s")
            for cue in res.cues:
                print(_fmt_cue(cue))

        # Compact comparison line.
        summary = "  |  ".join(
            f"{r.preset}: {r.n_cues} cues / {r.wall_s:.1f}s" for r in results
        )
        print(f"\n   summary: {summary}")

        md.append("| preset | overrides | #cues | wall (s) |")
        md.append("|---|---|---|---|")
        for r in results:
            md.append(
                f"| `{r.preset}` | `{PRESETS[r.preset] or '{}'}` | "
                f"{r.n_cues} | {r.wall_s:.1f} |"
            )
        md.append("")
        for r in results:
            md.append(f"<details><summary><code>{r.preset}</code> transcript "
                      f"({r.n_cues} cues)</summary>\n\n```")
            for cue in r.cues:
                md.append(_fmt_cue(cue).strip())
            md.append("```\n</details>\n")
    return md


def mode_score(
    clips: list[str], presets: list[str], language: str
) -> list[str]:
    """Score each preset's output on each clip against its ground-truth file.

    Prints per-clip CER/WER and mean-per-preset, and returns report lines.
    """
    md: list[str] = ["## Score (CER / WER, lower is better)\n"]
    # preset -> list of (cer, wer) across clips that had a reference.
    agg: dict[str, list[tuple[float, float]]] = {p: [] for p in presets}

    md.append("| clip | preset | CER | WER |")
    md.append("|---|---|---|---|")

    for clip in clips:
        gt = groundtruth_path(clip)
        header = f"clip: {os.path.basename(clip)}"
        print("\n" + "=" * len(header))
        print(header)
        print("=" * len(header))
        if not gt.exists():
            print(f"  no ground truth at {gt} -- skipping "
                  f"(create it or run --make-gt first)")
            md.append(f"| {os.path.basename(clip)} | *(no ground truth)* | - | - |")
            continue
        reference = gt.read_text(encoding="utf-8")
        for preset in presets:
            res = run_preset(clip, preset, language)
            hyp = cues_to_transcript(res.cues)
            c = cer(reference, hyp)
            w = wer(reference, hyp)
            agg[preset].append((c, w))
            print(f"  {preset:10s}  CER={c:.3f}  WER={w:.3f}  "
                  f"({res.n_cues} cues, {res.wall_s:.1f}s)")
            md.append(
                f"| {os.path.basename(clip)} | `{preset}` | "
                f"{c:.3f} | {w:.3f} |"
            )

    print("\n=== mean per preset ===")
    md.append("\n### Mean per preset\n")
    md.append("| preset | mean CER | mean WER | clips |")
    md.append("|---|---|---|---|")
    for preset in presets:
        vals = agg[preset]
        if not vals:
            print(f"  {preset:10s}  (no scored clips)")
            md.append(f"| `{preset}` | - | - | 0 |")
            continue
        mean_c = sum(v[0] for v in vals) / len(vals)
        mean_w = sum(v[1] for v in vals) / len(vals)
        print(f"  {preset:10s}  meanCER={mean_c:.3f}  meanWER={mean_w:.3f}  "
              f"(n={len(vals)})")
        md.append(f"| `{preset}` | {mean_c:.3f} | {mean_w:.3f} | {len(vals)} |")
    md.append("")
    return md


def mode_make_gt(clips: list[str], language: str) -> list[str]:
    """Bootstrap ground truth: run `current` on each clip and write a candidate.

    Writes ``eval/groundtruth/<clip-stem>.candidate.txt`` (one cue text per
    line, blank-line separated) for the user to review and rename to
    ``<clip-stem>.txt``. Returns report lines listing the files written.
    """
    _GROUNDTRUTH_DIR.mkdir(parents=True, exist_ok=True)
    md: list[str] = ["## make-gt (candidate transcripts written)\n"]
    for clip in clips:
        res = run_preset(clip, "current", language)
        out = _GROUNDTRUTH_DIR / f"{Path(clip).stem}.candidate.txt"
        body = "\n\n".join(c.text for c in res.cues)
        out.write_text(body + ("\n" if body else ""), encoding="utf-8")
        print(f"wrote {out}  ({res.n_cues} cues)  "
              f"-- review, then rename to {Path(clip).stem}.txt")
        md.append(f"- `{out}` ({res.n_cues} cues)")
    md.append("")
    return md


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #
def write_report(mode: str, presets: list[str], language: str,
                 clips: list[str], body: list[str]) -> None:
    """Write ``eval/report.md`` summarizing the run."""
    lines = [
        "# Subtitle-OCR evaluation report",
        "",
        f"- mode: `{mode}`",
        f"- language: `{language}`",
        f"- presets: {', '.join(f'`{p}`' for p in presets)}",
        f"- clips: {', '.join(f'`{os.path.basename(c)}`' for c in clips)}",
        f"- generated: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "## Presets",
        "",
        "| preset | overrides |",
        "|---|---|",
    ]
    for p in presets:
        lines.append(f"| `{p}` | `{PRESETS[p] or '{}'}` |")
    lines.append("")
    lines.extend(body)
    _REPORT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\nwrote report -> {_REPORT_PATH}")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def _collect_clips(args: argparse.Namespace) -> list[str]:
    """Resolve the clip list: explicit --clip(s), or cut one via --source."""
    clips: list[str] = list(args.clip or [])
    if args.source:
        if args.start is None or args.dur is None:
            raise SystemExit("--source requires --start and --dur")
        os.makedirs(args.clips_dir, exist_ok=True)
        stem = Path(args.source).stem.replace(" ", "_")
        out = os.path.join(
            args.clips_dir, f"{stem}_{int(args.start)}_{int(args.dur)}.mkv"
        )
        print(f"cutting clip -> {out}")
        cut_clip(args.source, args.start, args.dur, out)
        clips.append(out)
    if not clips:
        raise SystemExit("no clips: pass --clip PATH (repeatable) or --source/--start/--dur")
    missing = [c for c in clips if not os.path.exists(c)]
    if missing:
        raise SystemExit(f"clip(s) not found: {', '.join(missing)}")
    return clips


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="harness.py",
        description="Subtitle-OCR evaluation harness for the SubtitleExtractor "
                    "worker. Runs the real pipeline under named config presets "
                    "to compare (differential) or score (CER/WER) outputs.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        epilog="Run from the worker/ dir with the venv python so `import "
               "subextractor` resolves. See eval/README.md.",
    )
    p.add_argument(
        "mode",
        choices=["differential", "score", "scan"],
        nargs="?",
        default="differential",
        help="differential: compare presets; score: CER/WER vs ground truth; "
             "scan: find subtitle-dense windows in --source.",
    )
    p.add_argument("--clip", action="append", metavar="PATH",
                   help="path to a test clip (repeatable).")
    p.add_argument("--source", metavar="PATH",
                   help="source video to cut a clip from (with --start/--dur) "
                        "or to --scan.")
    p.add_argument("--start", type=float, metavar="SEC",
                   help="clip/scan start offset in seconds.")
    p.add_argument("--dur", type=float, metavar="SEC",
                   help="clip duration in seconds.")
    p.add_argument("--clips-dir", default=DEFAULT_CLIPS_DIR, metavar="DIR",
                   help="where cut clips are written (OUTSIDE the repo).")
    p.add_argument("--presets", default="current",
                   help="comma-separated preset names "
                        f"({', '.join(PRESETS)}).")
    p.add_argument("--language", default="fr",
                   help="subtitle language (selects the OCR rec model family).")
    p.add_argument("--make-gt", action="store_true",
                   help="run `current` on each clip and write candidate "
                        "ground-truth files for review (then exit).")
    # scan tuning.
    p.add_argument("--scan-top", type=int, default=8, metavar="N",
                   help="(scan) number of densest windows to print.")
    p.add_argument("--scan-window", type=float, default=45.0, metavar="SEC",
                   help="(scan) window length to aggregate density over.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.mode == "scan":
        if not args.source:
            raise SystemExit("scan mode requires --source")
        scan_source(args.source, args.scan_top, args.scan_window)
        return 0

    presets = [s.strip() for s in args.presets.split(",") if s.strip()]
    unknown = [p for p in presets if p not in PRESETS]
    if unknown:
        raise SystemExit(f"unknown preset(s): {', '.join(unknown)}; "
                         f"choose from {', '.join(PRESETS)}")

    clips = _collect_clips(args)

    if args.make_gt:
        body = mode_make_gt(clips, args.language)
        write_report("make-gt", ["current"], args.language, clips, body)
        return 0

    if args.mode == "differential":
        body = mode_differential(clips, presets, args.language)
    else:  # score
        body = mode_score(clips, presets, args.language)
    write_report(args.mode, presets, args.language, clips, body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
