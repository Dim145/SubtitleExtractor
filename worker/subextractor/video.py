"""Video frame sampling and subtitle-region cropping (OpenCV-based).

The macOS worker decodes with OpenCV (good enough for mp4/mkv H.264 on Apple
Silicon). The NVIDIA worker will swap this for ffmpeg NVDEC in a later milestone.
"""
from __future__ import annotations

import logging
import os
import queue
import re
import subprocess
import threading
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
    # Nominal interval (seconds) between consecutive sampled frames for THIS
    # decode path. The merge step uses it to extend a cue past its last frame.
    interval: float = 0.0


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
        # Real sampling interval: we step `step` source frames at video_fps, so
        # the wall-clock gap between sampled frames is step/video_fps (NOT the
        # nominal 1/sample_fps, which differs when sample_fps doesn't divide fps).
        interval = step / video_fps
        frame_no = 0
        while True:
            grabbed = cap.grab()
            if not grabbed:
                break
            if frame_no % step == 0:
                ok, frame = cap.retrieve()
                if ok and frame is not None:
                    yield SampledFrame(
                        timestamp=frame_no / video_fps,  # true source PTS
                        image=frame,
                        width=width,
                        height=height,
                        interval=interval,
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
    interval = 1.0 / max(sample_fps, 0.1)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "info"]
    if hwaccel:
        cmd += ["-hwaccel", hwaccel]
    # `fps=` resamples to a uniform output rate; `showinfo` then prints each output
    # frame's pts_time (seconds, derived from the SOURCE PTS) to stderr. We pair
    # each raw stdout frame with its showinfo pts_time so the ffmpeg path reports
    # true wall-clock timestamps that match the OpenCV path for the same video.
    cmd += [
        "-i", path,
        "-vf", f"fps={sample_fps},showinfo",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    # showinfo writes to stderr asynchronously; drain it on a thread so a full
    # stderr pipe can't deadlock the stdout read. pts_time values arrive in
    # output-frame order; we queue them and pair by index.
    pts_q: "queue.Queue[float]" = queue.Queue()
    err_tail: list[str] = []
    _pts_re = re.compile(r"pts_time:\s*([0-9]+(?:\.[0-9]+)?)")

    def _drain_stderr() -> None:
        assert proc.stderr is not None
        for raw_line in iter(proc.stderr.readline, b""):
            line = raw_line.decode("utf-8", "replace")
            m = _pts_re.search(line)
            if m:
                try:
                    pts_q.put(float(m.group(1)))
                except ValueError:
                    pass
            elif "error" in line.lower():
                err_tail.append(line.strip())
                if len(err_tail) > 5:
                    del err_tail[0]

    err_thread = threading.Thread(target=_drain_stderr, daemon=True)
    err_thread.start()

    frame_size = w * h * 3
    idx = 0
    try:
        assert proc.stdout is not None
        while True:
            raw = proc.stdout.read(frame_size)
            if len(raw) < frame_size:
                break
            frame = np.frombuffer(raw, np.uint8).reshape(h, w, 3)
            # Prefer the real pts_time for this output frame; if showinfo lags or
            # is unavailable, fall back to the uniform nominal time idx*interval.
            try:
                ts = pts_q.get(timeout=5.0)
            except queue.Empty:
                ts = idx * interval
            yield SampledFrame(timestamp=ts, image=frame, width=w, height=h, interval=interval)
            idx += 1
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        err_thread.join(timeout=1.0)
    if idx == 0:
        err = " | ".join(err_tail) if err_tail else (
            proc.stderr.read().decode("utf-8", "replace")[:300] if proc.stderr and not proc.stderr.closed else ""
        )
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
        emitted = 0
        try:
            for sf in sample_frames_ffmpeg(path, sample_fps, hwaccel):
                emitted += 1
                yield sf
            return
        except Exception as exc:  # noqa: BLE001
            # Only fall back to OpenCV if ffmpeg failed BEFORE emitting any frame.
            # Falling back mid-stream would restart from frame 0 and duplicate the
            # frames the consumer already kept (with an incompatible timestamp base).
            if emitted:
                log.error(
                    "ffmpeg %s decode failed after %d frame(s); re-raising "
                    "(cannot safely fall back mid-stream)", hwaccel, emitted,
                )
                raise
            log.warning("ffmpeg %s decode failed (%s); falling back to OpenCV", hwaccel, exc)
    yield from sample_frames(path, sample_fps)
