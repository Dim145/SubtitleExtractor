# SubtitleExtractor

Extract **hardcoded (burned-in) subtitles** from videos (mp4/mkv) using OCR, and edit
the resulting subtitles directly in the browser. Containerized web app.

See **[PLAN.md](PLAN.md)** for the full architecture, decisions, and roadmap.

## Status

End-to-end extraction plumbing is in place: upload a video → a worker claims it →
OCR pipeline → downloadable SRT/ASS. The control plane (M1–M3) is verified end-to-end.

| Milestone | Scope | State |
|---|---|---|
| M1 | API socle, auth, DB, storage | ✅ done |
| M2 | Upload + jobs (queue via Postgres `SKIP LOCKED`) | ✅ done |
| M3 | macOS worker + claim protocol | ✅ done¹ |
| M4 | SSE real-time progress/logs | ✅ done (EventSource + polling fallback) |
| M6 | NVIDIA worker | ✅ built (Docker overlay + ppocr GPU) — unverified (no NVIDIA hw) |
| M5 | Frontend: auth + dashboard + job detail + editor | ✅ done² |
| M7 | Client-side (browser) extraction | ✅ built (WebCodecs + onnxruntime-web/WebGPU, code-split) |
| — | Admin (users, settings, workers) + DB-backed dynamic worker config | ✅ done |
| — | 2-zone subtitle-area selector (WebCodecs, browser-only) | ✅ done³ |

¹ The Go control plane + claim protocol are tested end-to-end. The worker's OCR
pipeline compiles and is wired; running it on real video needs `ffmpeg` + the
Python deps on the host (`brew install ffmpeg`, then `./worker/run-macos.sh`).

² React + Vite frontend in `web/` — "Cutting Room" dark pro-tool theme (amber/cyan,
Archivo/Geist/JetBrains Mono). Login (local + OIDC), dashboard (upload + live job
list), job detail (progress/logs/downloads), and the subtitle **editor** (video
preview with live ASS overlay via JASSUB/libass-wasm, editable cue table synced to
playback, `\an` alignment, SRT/ASS export) — all verified against the running API.
The waveform timeline (wavesurfer) + save-to-server are part of the editor. Dev:
`cd web && npm install && npm run dev` (proxies `/api` to `localhost:8080`).

³ Workers register themselves in the DB (heartbeat), and their OCR config (backend,
fps, confidence, zones…) is admin-editable and pushed via the heartbeat's
`config_version` — no restart. Admin pages (`/admin`, admin-only) manage users, site
settings (registration toggle, defaults), and workers (status, enable/disable,
per-worker config, delete). Job routing is automatic. The subtitle-area selector
lets users draw up to two zones over the video; MKV/HEVC are decoded in-browser via
WebCodecs + a WASM demuxer (falls back to `<video>` for MP4/H.264). Up to two zones
are merged into one ASS with `\an` alignment from each zone's position.

## Layout

```
api/      Go API (chi) — auth, jobs, storage, SSE, /internal worker protocol
worker/   Python OCR worker (shared pipeline; macOS + NVIDIA backends)
web/      React + Vite frontend (subtitle editor)
graphify-out/  knowledge graph of the codebase (see CLAUDE.md)
```

## Quick start (dev)

```bash
cp .env.example .env          # then edit secrets (JWT_SIGNING_KEY, INTERNAL_API_TOKEN, ...)
docker compose up --build     # starts postgres + minio + api + web
# App (frontend):  http://localhost:3000   (nginx serves the SPA + proxies /api)
# API:             http://localhost:8080
# health check:    http://localhost:8080/healthz
# MinIO console:   http://localhost:9001
```

The macOS OCR worker runs natively on the host (Docker on macOS can't reach the
GPU): `brew install ffmpeg && cd worker && ./run-macos.sh`.

The API runs database migrations automatically on startup.

## Tech stack

- **API:** Go, chi, pgx, River (job queue), coreos/go-oidc, argon2id, minio-go
- **DB:** PostgreSQL 16
- **Worker:** Python — ffmpeg + RapidOCR / PP-OCRv5 / PaddleOCR-VL (configurable)
- **Frontend:** React + Vite + TypeScript; ass-compiler, JASSUB, wavesurfer.js
