# SubtitleExtractor — OCR worker

Polls the API for queued jobs, extracts hardcoded subtitles via OCR, and uploads
SRT/ASS results. The pipeline is shared; only the OCR backend differs per platform.

## Pipeline

```
download video → sample frames (ffmpeg/OpenCV) → crop subtitle band
  → SSIM frame-skip → OCR backend → Levenshtein-merge into timed cues
  → \an alignment from bbox → write SRT + ASS → upload results
```

## Backends (OCR_BACKEND)

| value          | platform        | install            | status |
|----------------|-----------------|--------------------|--------|
| `rapidocr`     | macOS / CPU     | default deps       | ✅ default |
| `ppocr`        | NVIDIA / CPU    | `pip install -e ".[ppocr]"` | ✅ |
| `paddleocr_vl` | macOS GPU (MLX) | `pip install -e ".[mlx]"` | ✅ Apple GPU (Metal) |

## macOS (Apple Silicon) — native

Docker on macOS cannot reach the Apple GPU, so the worker runs on the host.

```bash
brew install ffmpeg              # required
./run-macos.sh                   # creates .venv, installs deps, starts the worker
```

Configuration comes from the repo-root `.env` (`INTERNAL_API_TOKEN`) plus optional
overrides: `API_BASE_URL`, `WORKER_CLASS` (default `macos`), `OCR_BACKEND`,
`WORKER_DEFAULT_FPS`, `WORKER_DEFAULT_CROP` (`x:y:w:h`).

Run it permanently with launchd — see `com.subextractor.worker.plist.example`.

### Apple GPU (PaddleOCR-VL via MLX)

The `rapidocr` and `ppocr` backends are CPU-only on macOS. For OCR on the Apple
GPU (Metal), use `paddleocr_vl` — a vision-language model run via MLX:

```bash
cd worker && ./.venv/bin/pip install -e ".[mlx]"   # Apple Silicon only
```

Enable it per worker in the admin UI (Admin → Workers → Config):
`{"ocr_backend": "paddleocr_vl"}`. The model (`mlx-community/PaddleOCR-VL-1.5-4bit`,
~0.7 GB) downloads on first use and stays resident. Far more accurate than RapidOCR,
but ~3 s per OCR call vs ~0.3 s — best for accuracy-critical jobs / shorter clips;
the SSIM frame-skip keeps the call count down. Override the model with
`PADDLEOCR_VL_MODEL` (e.g. `mlx-community/PaddleOCR-VL-1.5-bf16` for best quality).

## NVIDIA (Linux host with an NVIDIA GPU)

Runs the `ppocr` backend (PaddleOCR + paddlepaddle-gpu) on CUDA. Containerized,
added to the stack via the overlay file:

```bash
# 1. Install nvidia-container-toolkit and verify GPU access:
docker run --rm --gpus all nvidia/cuda:12.4.1-base nvidia-smi
# 2. Launch the stack + GPU worker:
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d --build
```

The worker registers with `worker_class=gpu-nvidia` and advertises the `ppocr`
backend. Tune `paddlepaddle-gpu` to your CUDA version in `Dockerfile.nvidia` if the
default cu123 wheel doesn't match. `PPOCR_USE_GPU=1` and `PPOCR_LANG` control the
engine. (Frame decode currently uses OpenCV/CPU; ffmpeg NVDEC hardware decode is a
documented future optimization — `NVIDIA_DRIVER_CAPABILITIES` already includes
`video` for it.)

## Job parameters (sent at upload, stored on the job)

- `language` — OCR language hint
- `ocr_backend` — overrides the worker default for this job
- `fps` — frame sampling rate (higher = finer timing, slower)
- `crop` — subtitle region `x:y:w:h` in pixels (default: bottom ~38%)
- `formats` — any of `srt`, `ass`
