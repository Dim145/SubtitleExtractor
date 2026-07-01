"""Video frame sampling and subtitle-region cropping (OpenCV-based).

The macOS worker decodes with OpenCV (good enough for mp4/mkv H.264 on Apple
Silicon). The NVIDIA worker will swap this for ffmpeg NVDEC in a later milestone.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from dataclasses import dataclass
from typing import Iterator

import cv2
import numpy as np

log = logging.getLogger("subextractor")

# Whitelists for admin/DB-supplied decode options. Anything outside these is
# ignored and the safe default is used, so a bad config value can never be
# injected into the ffmpeg argv.
_KNOWN_DECODERS = frozenset({"opencv", "ffmpeg"})
_KNOWN_HWACCELS = frozenset({
    "", "none", "cuda", "videotoolbox", "vaapi", "qsv", "d3d11va", "dxva2",
    "vdpau", "opencl", "vulkan", "drm",
})


def _valid_decoder(decoder: str | None, default: str = "opencv") -> str:
    d = (decoder or default).lower()
    if d not in _KNOWN_DECODERS:
        log.warning("ignoring unknown decoder %r; using %r", decoder, default)
        return default
    return d


def _valid_hwaccel(hwaccel: str | None, default: str = "cuda") -> str:
    h = (hwaccel or default).lower()
    if h not in _KNOWN_HWACCELS:
        log.warning("ignoring unknown hwaccel %r; using %r", hwaccel, default)
        h = default
    return "" if h == "none" else h


@dataclass
class VideoInfo:
    width: int
    height: int
    fps: float
    frame_count: int
    # Presentation start of the video stream. A `-c copy` trim leaves the source
    # PTS intact, so a trimmed clip often starts at e.g. 9.94s rather than 0. We
    # preserve it so cue times match the source timeline (what players + the
    # reference SRTs honor) instead of being shifted earlier.
    start_time: float = 0.0

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


def _parse_rate(r: str | None) -> float | None:
    """Parse an ffprobe rate like '24000/1001' or '23.976' into fps."""
    try:
        if not r or r == "0/0":
            return None
        if "/" in r:
            n, d = r.split("/", 1)
            d = float(d)
            return float(n) / d if d else None
        return float(r)
    except (ValueError, ZeroDivisionError):
        return None


def _ffprobe(path: str) -> VideoInfo:
    """Probe via ffprobe — reliable for duration/fps/dims even on VFR or
    stream-copied (trimmed) files, where OpenCV's CAP_PROP_FRAME_COUNT/FPS lie."""
    cmd = [
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-of", "json",
        "-show_entries",
        "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames,duration,start_time:format=duration",
        path,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or "ffprobe failed").strip()[:200])
    data = json.loads(out.stdout or "{}")
    streams = data.get("streams") or []
    if not streams:
        raise RuntimeError("ffprobe: no video stream")
    st = streams[0]
    w, h = int(st.get("width") or 0), int(st.get("height") or 0)
    if w <= 0 or h <= 0:
        raise RuntimeError("ffprobe: bad dimensions")
    fps = _parse_rate(st.get("avg_frame_rate")) or _parse_rate(st.get("r_frame_rate")) or 25.0
    dur = None
    for v in (st.get("duration"), (data.get("format") or {}).get("duration")):
        try:
            dur = float(v)
            break
        except (TypeError, ValueError):
            continue
    nb_raw = str(st.get("nb_frames") or "")
    if nb_raw.isdigit() and int(nb_raw) > 0:
        nb = int(nb_raw)
    elif dur:
        nb = max(1, int(round(dur * fps)))
    else:
        raise RuntimeError("ffprobe: no duration or frame count")
    try:
        start = max(0.0, float(st.get("start_time")))
    except (TypeError, ValueError):
        start = 0.0
    return VideoInfo(width=w, height=h, fps=fps, frame_count=nb, start_time=start)


def _opencv_probe(path: str) -> VideoInfo:
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


def probe(path: str) -> VideoInfo:
    """Video metadata, preferring ffprobe (accurate) with an OpenCV fallback."""
    try:
        return _ffprobe(path)
    except Exception as e:  # noqa: BLE001
        log.warning("ffprobe failed (%s); falling back to OpenCV probe", e)
        return _opencv_probe(path)


def parse_crop(crop: str | None, width: int, height: int) -> tuple[int, int, int, int]:
    """Resolve the subtitle region as (x, y, w, h).

    Accepts "x:y:w:h" in pixels; otherwise defaults to the bottom ~38% of frame,
    where burned-in subtitles almost always sit.
    """
    if crop:
        try:
            x, y, w, h = (int(v) for v in crop.split(":"))
            # Clamp the origin to width-1/height-1 (consistent with _resolve_zones)
            # so at least one column/row of pixels always remains for the crop.
            x = max(0, min(x, width - 1))
            y = max(0, min(y, height - 1))
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
    # Source start_time (0 for most files; non-zero for `-c copy` trims) so the
    # OpenCV path emits source-timeline timestamps like the ffmpeg path.
    try:
        start = _ffprobe(path).start_time
    except Exception:  # noqa: BLE001
        start = 0.0
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
                        timestamp=start + frame_no / video_fps,  # source timeline
                        image=frame,
                        width=width,
                        height=height,
                        interval=interval,
                    )
            frame_no += 1
    finally:
        cap.release()


def sample_frames_ffmpeg(path: str, sample_fps: float, hwaccel: str = "cuda") -> Iterator[SampledFrame]:
    """Sample frames via ffmpeg with hardware decode (NVDEC / VideoToolbox).

    Decodes on the GPU (`-hwaccel`) and pipes raw BGR frames. Requires an ffmpeg
    build with the chosen hwaccel; callers should fall back to OpenCV.

    Timeline: `setpts=PTS-STARTPTS` rebases decoding to t=0 (so `fps=` doesn't
    sample a leading gap and the output is uniform — each frame is exactly
    `idx/fps` apart, with no fragile stdout/stderr showinfo pairing). We then add
    the stream's `start_time` back, so the emitted timestamps follow the SOURCE
    timeline — matching players and the reference SRTs (a `-c copy` trim leaves a
    non-zero start_time; subtracting it would make subtitles appear too early).
    """
    hwaccel = _valid_hwaccel(hwaccel, default="cuda")
    info = probe(path)
    w, h = info.width, info.height
    if w <= 0 or h <= 0:
        raise RuntimeError("could not determine video dimensions")
    interval = 1.0 / max(sample_fps, 0.1)
    start = info.start_time
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if hwaccel:
        cmd += ["-hwaccel", hwaccel]
    cmd += [
        "-i", path,
        # Force a known raw output geometry: `scale` pins the frame to the probed
        # dims (so a rotation/SAR mismatch can't make the raw stream a different
        # size than we reshape to) and `format=bgr24` locks the pixel layout.
        "-vf", f"setpts=PTS-STARTPTS,fps={sample_fps},scale={w}:{h},format=bgr24",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    # Drain stderr on a background thread so a chatty decoder can't fill the 64K
    # stderr pipe and deadlock the stdout frame pump. Cap what we retain.
    err_chunks: list[bytes] = []

    def _drain_stderr() -> None:
        try:
            assert proc.stderr is not None
            while True:
                chunk = proc.stderr.read(4096)
                if not chunk:
                    break
                if len(err_chunks) < 8:  # keep at most ~32K for diagnostics
                    err_chunks.append(chunk)
        except Exception:  # noqa: BLE001
            pass

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
            # The scale filter guarantees frame_size, but guard defensively so a
            # truncated/misaligned read raises cleanly instead of reshape-crashing.
            if len(raw) % frame_size != 0:
                raise RuntimeError(
                    f"ffmpeg raw frame size mismatch (got {len(raw)}, expected {frame_size})"
                )
            frame = np.frombuffer(raw, np.uint8).reshape(h, w, 3)
            yield SampledFrame(timestamp=start + idx * interval, image=frame, width=w, height=h, interval=interval)
            idx += 1
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        err_thread.join(timeout=2.0)
    if idx == 0:
        err = b"".join(err_chunks).decode("utf-8", "replace")[:300]
        raise RuntimeError(f"ffmpeg produced no frames (hwaccel={hwaccel}): {err}")


def sample_frames_auto(
    path: str, sample_fps: float, decoder: str | None = None, hwaccel: str | None = None
) -> Iterator[SampledFrame]:
    """Pick the decoder (opencv | ffmpeg). ffmpeg uses hardware decode (NVDEC /
    VideoToolbox); on failure it falls back to OpenCV. Args override env defaults."""
    decoder = _valid_decoder(decoder or os.environ.get("WORKER_DECODER", "opencv"))
    if decoder == "ffmpeg":
        hwaccel = _valid_hwaccel(hwaccel or os.environ.get("WORKER_HWACCEL", "cuda"))
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
