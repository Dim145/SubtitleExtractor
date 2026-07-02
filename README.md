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
| — | Optional per-user **storage quotas** (admin toggle · default · per-user override) | ✅ done |
| — | OCR quality pass: DBNet det-gate, auto-zone, deterministic French normalizer, in-browser OCR parity | ✅ done |
| — | Security & ops hardening: session revocation, CSRF, upload limits, `/readyz`, `/metrics`, per-worker enrollment tokens, CI test gate | ✅ done |

¹ The Go control plane + claim protocol are tested end-to-end. The worker's OCR
pipeline compiles and is wired; running it on real video needs `ffmpeg` + the
Python deps on the host (`brew install ffmpeg`, then `./worker/run-macos.sh`).

² React + Vite frontend in `web/` — "Cutting Room" dark pro-tool theme (amber/cyan,
Archivo/Geist/JetBrains Mono). Login (local + OIDC), dashboard (upload + live job
list), job detail (progress/logs/downloads), and the subtitle **editor** (video
preview with a live subtitle overlay, editable cue table synced to playback,
`\an` alignment, SRT/ASS export) — all verified against the running API.
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
```

## Quick start

```bash
cp .env.example .env          # then edit secrets (JWT_SIGNING_KEY, INTERNAL_API_TOKEN, ...)
```

**Run prebuilt images** (from GitHub Container Registry — no local build):

```bash
docker compose pull           # fetch ghcr.io/dim145/subtitleextractor-* images
docker compose up -d          # starts postgres + minio + api + web
```

Pin a version instead of `latest` with `IMAGE_TAG` (in `.env` or inline):
`IMAGE_TAG=0.1.0 docker compose up -d`.

**Or build locally** (for development):

```bash
docker compose up --build
```

```text
# App (frontend):  http://localhost:3000   (nginx serves the SPA + proxies /api)
# API:             http://localhost:8080
# liveness:        http://localhost:8080/healthz
# readiness:       http://localhost:8080/readyz    (checks DB + object store)
# metrics:         http://localhost:8080/metrics   (Prometheus; needs INTERNAL_API_TOKEN)
# MinIO console:   http://localhost:9001
```

The macOS OCR worker runs natively on the host (Docker on macOS can't reach the
GPU): `brew install ffmpeg && cd worker && ./run-macos.sh`.

The API runs database migrations automatically on startup.

## Production notes

- **Datastore ports are loopback-only.** In `docker-compose.yml`, `postgres`
  (5432), `minio` (9000/9001) and `api` (8080) are published on `127.0.0.1`
  only — reachable from the host, not the public network. Only `web` (the
  intended entrypoint) is published broadly.
- **Put a TLS reverse proxy in front of `web`.** The compose stack serves plain
  HTTP; terminate TLS with nginx/Caddy/Traefik ahead of the `web` service.
- Resource limits on `api`/`web` in compose are conservative defaults — tune
  `deploy.resources.limits` to your host. The OCR worker runs outside compose.

## Backup & restore

The recovery path is the **database + object store**, not the source videos: the
video-retention cron deletes uploaded source videos on a schedule (admin-
configurable, default ~7 days), so once a video ages out it is gone — the
extracted subtitles and job metadata in Postgres/MinIO are what you restore.

Back up the two data volumes (`pgdata`, `miniodata`):

```bash
# PostgreSQL — logical dump (restore with `psql` or `pg_restore`)
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > backup.sql

# MinIO — mirror the bucket to a local/offsite path with the mc client
docker compose exec -T minio sh -c \
  'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" \
   && mc mirror --overwrite local/'"${STORAGE_S3_BUCKET:-subext}"' /data/backup'
```

To restore: recreate the volumes, `psql < backup.sql`, and `mc mirror` the
saved bucket contents back into `local/<bucket>`.

## Storage quotas (optional)

Off by default. In **Admin › Settings**, enable "Storage quotas" and set a
default per-user limit; override it per user in **Admin › Users** (empty =
inherit the default, `0` = unlimited). Usage counts a user's currently-stored
source videos + generated subtitle files, so deleting a video frees space. An
upload that would exceed the quota is rejected with an explicit message, and
each user sees their used/total on the dashboard. Only admins change quotas.

## Security & operations

- **Sessions** are revocable: logout and password changes invalidate existing
  session tokens (per-user token version).
- **CSRF:** state-changing requests are checked same-origin (Origin/Referer vs
  the request host, or a configured `API_PUBLIC_URL` / `API_CORS_ORIGINS`). If
  you front the app with your own reverse proxy, it **must forward the original
  `Host` header including the port** (the shipped nginx uses `proxy_set_header
  Host $http_host`) — otherwise authenticated writes are rejected as cross-origin.
- **Workers** use per-worker tokens: `INTERNAL_API_TOKEN` is only an enrollment
  secret — each worker exchanges it for its own token on startup (stateless,
  nothing to persist worker-side), and the bootstrap token alone cannot claim
  jobs or read source videos.
- **Uploads** are capped by `MAX_UPLOAD_BYTES` (default 2 GiB) and, when enabled,
  by per-user storage quotas.
- **Observability:** JSON access logs with request IDs, `/readyz` (DB + storage
  probe), and Prometheus `/metrics` (job/queue/worker gauges).

## Tech stack

- **API:** Go, chi, pgx, Postgres-backed queue (`FOR UPDATE SKIP LOCKED`), coreos/go-oidc, argon2id, minio-go, prometheus/client_golang
- **DB:** PostgreSQL 16
- **Worker:** Python — ffmpeg + RapidOCR / PP-OCRv5 / PaddleOCR-VL (configurable), deterministic French text normalizer
- **Frontend:** React + Vite + TypeScript; ass-compiler, wavesurfer.js

## License

Licensed under the **GNU Affero General Public License v3.0 or later** (AGPL-3.0) —
see [LICENSE](LICENSE). If you run a modified version to provide a network service,
the AGPL requires you to offer your modified source to its users.
