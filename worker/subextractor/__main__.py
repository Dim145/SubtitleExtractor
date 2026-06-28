"""Worker entrypoint: heartbeat (register + fetch config), claim jobs, run each
in a disposable child process, report status. The OCR model lives in the child
(see runner.py), so all RAM + VRAM is reclaimed when the worker goes idle — the
child is killed after the grace period. This parent process stays small: it does
NOT import the OCR pipeline (cv2/paddle/onnxruntime live only in the child)."""
from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

from .client import APIClient
from .config import Config
from .runner import JobRunner

log = logging.getLogger("subextractor")


def _start_health_pinger() -> None:
    """Touch a liveness file every few seconds from a daemon thread, so a
    container HEALTHCHECK can detect a hung/dead worker even while the main loop
    is blocked running a job. The thread only stops if the process itself dies."""
    path = os.environ.get("WORKER_HEALTH_FILE", "/tmp/subextractor.health")

    def _ping() -> None:
        while True:
            try:
                Path(path).touch()
            except OSError:
                pass
            time.sleep(5)

    threading.Thread(target=_ping, name="health-pinger", daemon=True).start()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = Config.from_env()
    client = APIClient(cfg)
    runner = JobRunner(cfg)
    _start_health_pinger()
    log.info("worker started: name=%s class=%s api=%s", cfg.worker_name, cfg.worker_class, cfg.api_base_url)

    was_disabled = False
    last_active = time.monotonic()
    try:
        while True:
            # Heartbeat = register + liveness + pull latest admin config.
            try:
                hb = client.worker_heartbeat()
            except Exception as exc:  # noqa: BLE001
                log.warning("heartbeat failed: %s", exc)
                time.sleep(cfg.poll_interval)
                continue

            if not hb.get("enabled", True):
                if not was_disabled:
                    log.info("worker is disabled by admin — idling")
                    was_disabled = True
                if runner.is_alive():
                    runner.shutdown()  # free memory while disabled
                time.sleep(cfg.poll_interval)
                continue
            if was_disabled:
                log.info("worker re-enabled")
                was_disabled = False

            wcfg = hb.get("config") or {}
            sub_rules = hb.get("ocrSubstitutionRules") or []
            try:
                poll = float(wcfg.get("poll_interval") or cfg.poll_interval)
            except (TypeError, ValueError):
                poll = cfg.poll_interval
            try:
                grace = float(wcfg.get("model_unload_grace") if wcfg.get("model_unload_grace") is not None
                              else os.environ.get("WORKER_MODEL_GRACE", 300))
            except (TypeError, ValueError):
                grace = 300.0

            try:
                claimed = client.claim()
            except Exception as exc:  # noqa: BLE001
                log.warning("claim failed: %s", exc)
                time.sleep(poll)
                continue

            if claimed is None:
                # Kill the idle OCR child after the grace period → frees RAM + VRAM.
                if grace > 0 and runner.is_alive() and (time.monotonic() - last_active) > grace:
                    runner.shutdown()
                    log.info("freed OCR subprocess after %.0fs idle", grace)
                time.sleep(poll)
                continue

            last_active = time.monotonic()
            job, input_url = claimed
            job_id = job["id"]
            log.info("claimed job %s (%s)", job_id, job.get("sourceFilename"))
            try:
                status = runner.run_job(job, input_url, wcfg, sub_rules)
                if status == "canceled":
                    # The API already marked it canceled and cleaned up; don't fail it.
                    log.info("job %s canceled — aborted", job_id)
                else:
                    client.complete(job_id, success=True)
                    log.info("job %s succeeded", job_id)
            except Exception as exc:  # noqa: BLE001
                detail = str(exc)
                first = detail.splitlines()[0] if detail else "error"
                log.error("job %s failed: %s", job_id, first)
                try:
                    client.log(job_id, detail, level="error")
                    client.complete(job_id, success=False, error=first)
                except Exception:  # noqa: BLE001
                    log.exception("failed to report job failure")
            finally:
                last_active = time.monotonic()  # start the idle grace from job end
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        runner.shutdown()
        client.close()


if __name__ == "__main__":
    main()
