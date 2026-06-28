"""Worker entrypoint: heartbeat (register + fetch config), claim jobs, run the
pipeline, report status. OCR parameters are admin-controlled via the API."""
from __future__ import annotations

import logging
import os
import time
import traceback

from . import backends
from .client import APIClient, JobCanceled
from .config import Config
from .pipeline import process_job

log = logging.getLogger("subextractor")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = Config.from_env()
    client = APIClient(cfg)
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
                time.sleep(cfg.poll_interval)
                continue
            if was_disabled:
                log.info("worker re-enabled")
                was_disabled = False

            wcfg = hb.get("config") or {}
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
                # Free the model after a grace period of inactivity (frees GPU/VRAM).
                if grace > 0 and backends.is_loaded() and (time.monotonic() - last_active) > grace:
                    n = backends.unload_all()
                    log.info("unloaded %d model(s) after %.0fs idle", n, grace)
                time.sleep(poll)
                continue

            last_active = time.monotonic()
            job, input_url = claimed
            job_id = job["id"]
            log.info("claimed job %s (%s)", job_id, job.get("sourceFilename"))
            try:
                process_job(cfg, client, job, input_url, wcfg)
                client.complete(job_id, success=True)
                log.info("job %s succeeded", job_id)
            except JobCanceled:
                # The API already set the job to canceled and cleaned its row;
                # the temp dir was removed on the way out. Don't mark it failed.
                log.info("job %s canceled — aborted", job_id)
            except Exception as exc:  # noqa: BLE001
                err = f"{type(exc).__name__}: {exc}"
                log.error("job %s failed: %s", job_id, err)
                log.debug(traceback.format_exc())
                try:
                    client.log(job_id, traceback.format_exc(), level="error")
                    client.complete(job_id, success=False, error=err)
                except Exception:  # noqa: BLE001
                    log.exception("failed to report job failure")
            finally:
                last_active = time.monotonic()  # start the idle grace from job end
    except KeyboardInterrupt:
        log.info("shutting down")
    finally:
        client.close()


if __name__ == "__main__":
    main()
