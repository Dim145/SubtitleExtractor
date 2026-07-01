"""Run OCR jobs in a disposable child process.

Killing the child returns ALL of its memory — host RAM and GPU VRAM — to the OS.
An in-process unload cannot do this: Python/glibc don't return freed heap to the
OS, and frameworks (paddle, onnxruntime, opencv) stay imported with their own
allocator pools. So the worker keeps one child alive while it's busy, reuses it
across consecutive jobs (model stays warm), and kills it after the idle grace.

The heavy imports (cv2, paddle, …) happen only inside the child, so the parent
orchestrator process stays small.
"""
from __future__ import annotations

import logging
import multiprocessing as mp
import os

from .config import Config

log = logging.getLogger("subextractor")

# spawn → a clean child with no inherited fds/threads/HTTP pools from the parent.
_ctx = mp.get_context("spawn")


def _max_job_seconds() -> float:
    """Wall-clock budget for a single job. A wedged native lib (paddle/onnx/
    ffmpeg) can hang the child while still looking alive; the watchdog kills it
    past this budget so the worker doesn't silently stall. 0/negative disables."""
    try:
        return float(os.environ.get("WORKER_MAX_JOB_SECONDS", "3600"))
    except ValueError:
        return 3600.0


def _child_loop(cfg: Config, conn) -> None:
    """Child entrypoint: own API client + OCR pipeline, serving one job at a time.
    Models are loaded lazily by process_job and cached in THIS process, so they
    stay warm across jobs until the parent kills us."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [ocr-child] %(message)s",
    )
    from .client import APIClient, JobCanceled
    from .pipeline import process_job

    client = APIClient(cfg)
    try:
        while True:
            task = conn.recv()
            if task is None:  # shutdown sentinel
                break
            job, input_url, wcfg, sub_rules = task
            try:
                process_job(cfg, client, job, input_url, wcfg, sub_rules)
                conn.send(("done", None))
            except JobCanceled:
                conn.send(("canceled", None))
            except Exception as exc:  # noqa: BLE001
                import traceback
                conn.send(("error", f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"))
    except (EOFError, KeyboardInterrupt):
        pass
    finally:
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass


class JobRunner:
    """Parent-side handle to a lazily-spawned, killable OCR child process."""

    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self._proc: mp.Process | None = None
        self._conn = None

    def is_alive(self) -> bool:
        return self._proc is not None and self._proc.is_alive()

    def _ensure(self) -> None:
        if self.is_alive():
            return
        parent_conn, child_conn = _ctx.Pipe()
        self._conn = parent_conn
        self._proc = _ctx.Process(target=_child_loop, args=(self._cfg, child_conn), daemon=True)
        self._proc.start()
        child_conn.close()  # the parent only keeps its own end
        log.info("spawned OCR subprocess (pid=%s)", self._proc.pid)

    def run_job(self, job: dict, input_url: str, wcfg: dict, sub_rules: list) -> str:
        """Run one job in the child and block for the result. Returns 'done' or
        'canceled'; raises RuntimeError if the job failed or the child died."""
        self._ensure()
        budget = _max_job_seconds()
        try:
            self._conn.send((job, input_url, wcfg, sub_rules))
            # Watchdog: block on recv() but wake up to enforce a max-duration
            # budget so a wedged native lib can't hang the worker indefinitely.
            if budget > 0:
                if not self._conn.poll(budget):
                    log.error(
                        "OCR job %s exceeded %.0fs budget; killing child",
                        job.get("id"), budget,
                    )
                    self.shutdown()  # reap the wedged child; caller fails the job
                    raise RuntimeError(f"OCR job exceeded {budget:.0f}s budget (killed)")
            status, payload = self._conn.recv()
        except (EOFError, BrokenPipeError, OSError) as exc:
            self.shutdown()  # child crashed (e.g. native fault) — reap it
            raise RuntimeError(f"OCR subprocess died: {exc}") from exc
        if status == "error":
            raise RuntimeError(payload)
        return status

    def shutdown(self) -> None:
        """Kill the child, returning its RAM/VRAM to the OS. Safe if not running."""
        proc, conn = self._proc, self._conn
        self._proc, self._conn = None, None
        if proc is None:
            return
        try:
            if proc.is_alive() and conn is not None:
                try:
                    conn.send(None)  # ask for a clean exit first
                except Exception:  # noqa: BLE001
                    pass
                proc.join(timeout=5)
            if proc.is_alive():
                proc.terminate()
                proc.join(timeout=5)
            if proc.is_alive():
                proc.kill()
                proc.join(timeout=2)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass
