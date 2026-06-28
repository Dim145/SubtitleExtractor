#!/usr/bin/env bash
# Run the OCR worker natively on macOS (Apple Silicon). Docker on macOS cannot
# reach the Apple GPU, so this worker runs on the host, not in a container.
#
# Prerequisites:
#   - Python 3.10+
#   - ffmpeg on PATH  (brew install ffmpeg)
set -euo pipefail
cd "$(dirname "$0")"

# Load shared secrets from the repo-root .env if present (INTERNAL_API_TOKEN, ...).
if [ -f ../.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ../.env
  set +a
fi

: "${INTERNAL_API_TOKEN:?INTERNAL_API_TOKEN must be set (see ../.env)}"
export API_BASE_URL="${API_BASE_URL:-http://localhost:8080}"
export WORKER_CLASS="${WORKER_CLASS:-macos}"
export OCR_BACKEND="${OCR_BACKEND:-rapidocr}"

if [ ! -d .venv ]; then
  echo "Creating virtualenv..."
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate

echo "Installing/refreshing dependencies..."
pip install -q --upgrade pip
pip install -q -e .

echo "Starting worker (class=$WORKER_CLASS backend=$OCR_BACKEND api=$API_BASE_URL)"
exec python -m subextractor
