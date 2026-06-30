"""Subtitle file writers: SRT, ASS and WebVTT.

ASS is the richer master format — it carries the \\an alignment recovered from
the OCR bounding box. SRT and WebVTT are plain timed-text down-conversions.
"""
from __future__ import annotations

import re

from .dedup import Cue

# A line that is exactly "-->" (optionally surrounded by whitespace) would be
# read by an SRT/VTT parser as a timing line; "-->" anywhere in a VTT cue body
# is also illegal. Used to sanitize cue text below.
_ARROW_RE = re.compile(r"-->")


def _clean_block(text: str, *, escape_arrows: bool) -> str:
    """Make cue text safe to embed in an SRT/VTT block: strip blank lines (a blank
    line ends a cue) and neutralize `-->` so a line can't be mistaken for a timing
    line or, in VTT, violate the no-`-->`-in-body rule."""
    out: list[str] = []
    for ln in text.split("\n"):
        ln = ln.rstrip("\r")
        if escape_arrows:
            ln = _ARROW_RE.sub("->", ln)  # VTT: '-->' is illegal anywhere in body
        elif ln.strip() == "-->":
            ln = "->"  # SRT: a lone '-->' line looks like a timing line
        if ln.strip():  # drop blank lines (they terminate the cue block)
            out.append(ln)
    return "\n".join(out)


def _srt_time(t: float) -> str:
    if t < 0:
        t = 0
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _vtt_time(t: float) -> str:
    # WebVTT uses a dot for the millisecond separator (HH:MM:SS.mmm).
    return _srt_time(t).replace(",", ".")


def _ass_time(t: float) -> str:
    if t < 0:
        t = 0
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360_000)
    m, cs = divmod(cs, 6_000)
    s, cs = divmod(cs, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"


def write_srt(cues: list[Cue], path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        for i, c in enumerate(cues, start=1):
            text = _clean_block(c.text, escape_arrows=False)
            if not text:
                continue
            fh.write(f"{i}\n{_srt_time(c.start)} --> {_srt_time(c.end)}\n{text}\n\n")


def write_vtt(cues: list[Cue], path: str) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("WEBVTT\n\n")
        for i, c in enumerate(cues, start=1):
            text = _clean_block(c.text, escape_arrows=True)
            if not text:
                continue
            fh.write(f"{i}\n{_vtt_time(c.start)} --> {_vtt_time(c.end)}\n{text}\n\n")


def write_ass(cues: list[Cue], path: str, width: int, height: int, fontsize: int = 0) -> None:
    if fontsize <= 0:
        # A reasonable default proportional to frame height.
        fontsize = max(16, int(height * 0.05))

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,{fontsize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(header)
        for c in cues:
            text = c.text.replace("\n", "\\N")
            tag = f"{{\\an{c.an}}}" if c.an and c.an != 2 else ""
            # Stash the OCR confidence (0..1) in the otherwise-unused Name field.
            # Players ignore it; our editor reads it to flag low-confidence cues.
            conf = getattr(c, "confidence", None)
            name = f"{conf:.2f}" if conf is not None else ""
            fh.write(f"Dialogue: 0,{_ass_time(c.start)},{_ass_time(c.end)},Default,{name},0,0,0,,{tag}{text}\n")
