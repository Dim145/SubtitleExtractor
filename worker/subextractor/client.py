"""HTTP client for the API's /internal worker protocol."""
from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

from .config import Config

log = logging.getLogger("subextractor")


class JobCanceled(Exception):
    """Raised when the API reports a job was canceled/deleted (HTTP 409)."""


class APIClient:
    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self._http = httpx.Client(
            base_url=cfg.api_base_url,
            headers={
                "Authorization": f"Bearer {cfg.internal_token}",
                "X-Worker-Id": cfg.worker_name,
            },
            timeout=httpx.Timeout(60.0, read=120.0),
        )

    def close(self) -> None:
        self._http.close()

    def worker_heartbeat(self) -> dict[str, Any]:
        """Register/refresh this worker and fetch its enabled flag + effective config."""
        resp = self._http.post(
            "/api/internal/workers/heartbeat",
            json={
                "name": self._cfg.worker_name,
                "workerClass": self._cfg.worker_class,
                "capabilities": self._cfg.capabilities,
            },
        )
        resp.raise_for_status()
        return resp.json()

    def claim(self) -> tuple[dict[str, Any], str] | None:
        """Claim the next job. Returns (job, input_url) or None if the queue is empty."""
        resp = self._http.post("/api/internal/jobs/claim", params={"worker_class": self._cfg.worker_class})
        if resp.status_code == 204:
            return None
        resp.raise_for_status()
        body = resp.json()
        return body["job"], body["inputUrl"]

    def progress(self, job_id: str, pct: int, stage: str, log: str | None = None) -> None:
        payload: dict[str, Any] = {"pct": int(pct), "stage": stage}
        if log:
            payload["log"] = log
        resp = self._http.post(f"/api/internal/jobs/{job_id}/progress", json=payload)
        if resp.status_code == 409:
            raise JobCanceled(job_id)

    def heartbeat(self, job_id: str) -> None:
        resp = self._http.post(f"/api/internal/jobs/{job_id}/heartbeat")
        if resp.status_code >= 300:
            log.warning("heartbeat for job %s returned HTTP %s", job_id, resp.status_code)

    def log(self, job_id: str, message: str, level: str = "info") -> None:
        resp = self._http.post(
            f"/api/internal/jobs/{job_id}/log", json={"level": level, "message": message}
        )
        if resp.status_code >= 300:
            log.warning("log post for job %s returned HTTP %s", job_id, resp.status_code)

    def upload_result(self, job_id: str, file_path: str, kind: str, language: str | None = None) -> None:
        with open(file_path, "rb") as fh:
            files = {"file": (os.path.basename(file_path), fh, "application/octet-stream")}
            data = {"kind": kind}
            if language:
                data["language"] = language
            resp = self._http.put(f"/api/internal/jobs/{job_id}/result", files=files, data=data)
            resp.raise_for_status()

    def complete(self, job_id: str, success: bool, error: str | None = None) -> None:
        """Report terminal status. A failed complete leaves the job stuck
        "running", so retry a few times with backoff and log loudly if it never
        lands (the API's heartbeat-timeout reaper is the last-resort safety net)."""
        payload: dict[str, Any] = {"status": "success" if success else "failure"}
        if error:
            payload["error"] = error[:2000]
        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                resp = self._http.post(f"/api/internal/jobs/{job_id}/complete", json=payload)
                if resp.status_code < 300:
                    return
                log.warning(
                    "complete for job %s returned HTTP %s (attempt %d/3)",
                    job_id, resp.status_code, attempt + 1,
                )
            except httpx.HTTPError as exc:
                last_exc = exc
                log.warning("complete for job %s failed (attempt %d/3): %s", job_id, attempt + 1, exc)
            if attempt < 2:
                time.sleep(1.0 * (attempt + 1))
        log.error(
            "complete for job %s never succeeded; job may be stuck 'running' "
            "until the API heartbeat reaper reclaims it%s",
            job_id, f" ({last_exc})" if last_exc else "",
        )

    def download(self, url: str, dest_path: str) -> None:
        """Download the input video. The URL may be absolute (S3) or API-relative (local)."""
        target = url if url.startswith("http") else f"{self._cfg.api_base_url}{url}"
        with self._http.stream("GET", target) as resp:
            resp.raise_for_status()
            with open(dest_path, "wb") as fh:
                for chunk in resp.iter_bytes(chunk_size=1 << 20):
                    fh.write(chunk)
