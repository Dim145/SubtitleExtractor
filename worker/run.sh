#!/usr/bin/env bash
# Self-contained launcher for the SubtitleExtractor macOS worker.
#
# Quick start (from the unzipped folder):
#   1. cp .env.example .env   &&   edit .env (API_BASE_URL + INTERNAL_API_TOKEN)
#   2. ./run.sh
#
# First run creates a local virtualenv and installs dependencies (a few minutes);
# later runs start immediately. Delete the .venv folder to force a reinstall.
set -euo pipefail
cd "$(dirname "$0")"

# Load configuration from a local .env, then fall back to the repo-root one
# (handy when running from inside the source tree).
for envfile in .env ../.env; do
  if [ -f "$envfile" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$envfile"
    set +a
    break
  fi
done

: "${API_BASE_URL:?Set API_BASE_URL in .env (e.g. http://192.168.1.50:8080)}"
: "${INTERNAL_API_TOKEN:?Set INTERNAL_API_TOKEN in .env (must match the API)}"
export API_BASE_URL INTERNAL_API_TOKEN
export WORKER_CLASS="${WORKER_CLASS:-macos}"

command -v ffmpeg >/dev/null 2>&1 || { echo "ERROR: ffmpeg not found — install it:  brew install ffmpeg"; exit 1; }
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || { echo "ERROR: python3 not found — install Python 3.10+"; exit 1; }

if [ ! -d .venv ]; then
  echo "First run: creating virtualenv and installing dependencies (a few minutes)…"
  "$PY" -m venv .venv
  ./.venv/bin/pip install -q --upgrade pip
  if [ "$(uname -m)" = "arm64" ]; then
    # Apple Silicon: include the MLX extra for GPU OCR (PaddleOCR-VL on Metal).
    echo "Apple Silicon detected — installing with the MLX GPU backend."
    ./.venv/bin/pip install ".[mlx]"
  else
    ./.venv/bin/pip install .
  fi
fi

echo "Starting worker (class=$WORKER_CLASS, api=$API_BASE_URL). Ctrl-C to stop."
exec ./.venv/bin/python -m subextractor
