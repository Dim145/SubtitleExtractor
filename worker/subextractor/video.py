"""Video frame sampling and subtitle-region cropping (OpenCV-based).

The macOS worker decodes with OpenCV (good enough for mp4/mkv H.264 on Apple
Silicon). The NVIDIA worker will swap this for ffmpeg NVDEC in a later milestone.
"""
from __future__ import annotations

import logging
import os
import subprocess
from dataclasses import dataclass
from typing import Iterator

import cv2
import numpy as np

log = logging.getLogger("subextractor")


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    frame_count: int

    @property
    def duration(self) -> float:
        return self.frame_count / self.fps if self.fps else 0.0


@dataclass
class SampledFrame:
    timestamp: float
    image: np.ndarray  # full BGR frame
    width: int
    height: int


def probe(path: str) -> VideoInfo:
    cap = cv2.VideoCapture(path)
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        if fps <= 0:
            fps = 25.0
        return VideoInfo(
            width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
            height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            fps=fps,
            frame_count=int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
        )
    finally:
        cap.release()


def parse_crop(crop: str | None, width: int, height: int) -> tuple[int, int, int, int]:
    """Resolve the subtitle region as (x, y, w, h).

    Accepts "x:y:w:h" in pixels; otherwise defaults to the bottom ~38% of frame,
    where burned-in subtitles almost always sit.
    """
    if crop:
        try:
            x, y, w, h = (int(v) for v in crop.split(":"))
            x = max(0, min(x, width))
            y = max(0, min(y, height))
            w = max(1, min(w, width - x))
            h = max(1, min(h, height - y))
            return x, y, w, h
        except ValueError:
            pass
    y = int(height * 0.62)
    return 0, y, width, height - y


def sample_frames(path: str, sample_fps: float) -> Iterator[SampledFrame]:
    """Yield full frames at the requested sampling rate. Cropping to subtitle
    zones happens downstream so a single decode serves multiple zones."""
    cap = cv2.VideoCapture(path)
    try:
        video_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        if video_fps <= 0:
            video_fps = 25.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        step = max(1, round(video_fps / max(sample_fps, 0.1)))
        frame_no = 0
        while True:
            grabbed = cap.grab()
            if not grabbed:
                break
            if frame_no % step == 0:
                ok, frame = cap.retrieve()
                if ok and frame is not None:
                    yield SampledFrame(
                        timestamp=frame_no / video_fps,
                        image=frame,
                        width=width,
                        height=height,
                    )
            frame_no += 1
    finally:
        cap.release()


def sample_frames_ffmpeg(path: str, sample_fps: float, hwaccel: str = "cuda") -> Iterator[SampledFrame]:
    """Sample frames via ffmpeg with hardware decode (NVDEC on NVIDIA).

    Decodes on the GPU (`-hwaccel cuda`) and pipes raw BGR frames. Requires an
    ffmpeg build with the chosen hwaccel; callers should fall back to OpenCV.
    """
    info = probe(path)
    w, h = info.width, info.height
    if w <= 0 or h <= 0:
        raise RuntimeError("could not determine video dimensions")
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if hwaccel:
        cmd += ["-hwaccel", hwaccel]
    cmd += [
        "-i", path,
        "-vf", f"fps={sample_fps}",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_size = w * h * 3
    idx = 0
    try:
        assert proc.stdout is not None
        while True:
            raw = proc.stdout.read(frame_size)
            if len(raw) < frame_size:
                break
            frame = np.frombuffer(raw, np.uint8).reshape(h, w, 3)
            yield SampledFrame(timestamp=idx / sample_fps, image=frame, width=w, height=h)
            idx += 1
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
    if idx == 0:
        err = proc.stderr.read().decode("utf-8", "replace")[:300] if proc.stderr else ""
        raise RuntimeError(f"ffmpeg produced no frames (hwaccel={hwaccel}): {err}")


def sample_frames_auto(
    path: str, sample_fps: float, decoder: str | None = None, hwaccel: str | None = None
) -> Iterator[SampledFrame]:
    """Pick the decoder (opencv | ffmpeg). ffmpeg uses hardware decode (NVDEC /
    VideoToolbox); on failure it falls back to OpenCV. Args override env defaults."""
    decoder = (decoder or os.environ.get("WORKER_DECODER", "opencv")).lower()
    if decoder == "ffmpeg":
        hwaccel = (hwaccel or os.environ.get("WORKER_HWACCEL", "cuda")).lower()
        if hwaccel == "none":
            hwaccel = ""
        try:
            yield from sample_frames_ffmpeg(path, sample_fps, hwaccel)
            return
        except Exception as exc:  # noqa: BLE001
            log.warning("ffmpeg %s decode failed (%s); falling back to OpenCV", hwaccel, exc)
    yield from sample_frames(path, sample_fps)
