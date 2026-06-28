# SubtitleExtractor — macOS worker

A ready-to-run OCR worker for macOS. It polls your SubtitleExtractor API for
queued jobs, extracts hardcoded subtitles, and uploads the results. It runs
natively on the host because Docker on macOS cannot reach the Apple GPU.

## Requirements

- **macOS** with **Python 3.10+** — check: `python3 --version`
- **ffmpeg** — install with [Homebrew](https://brew.sh): `brew install ffmpeg`

## Setup (3 steps)

1. Copy the example config and edit it:
   ```bash
   cp .env.example .env
   ```
   In `.env`, set:
   - `API_BASE_URL` — your API's address (e.g. `http://192.168.1.50:8080`)
   - `INTERNAL_API_TOKEN` — must match `INTERNAL_API_TOKEN` on the API
2. Make sure ffmpeg is installed (`brew install ffmpeg`).
3. Start the worker:
   ```bash
   ./run.sh
   ```

The **first run** creates a local virtualenv and installs dependencies (a few
minutes). On **Apple Silicon** it also installs the MLX GPU backend
(`paddleocr_vl`). Later runs start immediately.

Leave it running — it polls for jobs until you stop it with **Ctrl-C**.

## Notes

- The OCR backend (`rapidocr` CPU, or `paddleocr_vl` Apple GPU) can be chosen
  per-worker from the web UI's **Admin → Workers** page.
- To force a clean reinstall of dependencies, delete the `.venv` folder and run
  `./run.sh` again.
