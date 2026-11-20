"""Run an inversion on the remote inversion server (the same backend on a big VM) instead of this process.

The server URL comes from ``RESIST_INVERSION_SERVER_URL`` or ``backend/inversion_server.json`` (``{"url": ...}``).
A server job is mirrored by a local proxy job: submit forwards the request, every status read of the proxy job polls
the server, and the finished result is saved into the local store too (both write the same Cosmos graph; the save is
idempotent and keeps the local snapshot complete).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

CONFIG_PATH = Path(__file__).resolve().parents[1] / "inversion_server.json"
ENV_URL = "RESIST_INVERSION_SERVER_URL"
HEALTH_TIMEOUT_S = 2.0
HEALTH_TTL_S = 30.0
SUBMIT_TIMEOUT_S = 30.0
POLL_TIMEOUT_S = 30.0
POLL_INTERVAL_S = 1.0
MAX_POLL_FAILURES = 5

_health_cache: dict = {}
_poll_lock = threading.Lock()


class RemoteError(Exception):
    """The inversion server could not be reached or refused the request."""


def server_url() -> str | None:
    url = os.environ.get(ENV_URL, "").strip()
    if not url:
        try:
            url = (json.loads(CONFIG_PATH.read_text(encoding="utf-8")).get("url") or "").strip()
        except (OSError, ValueError, AttributeError):
            url = ""
    return url.rstrip("/") or None


def _request(method: str, url: str, body: dict | None = None, timeout: float = POLL_TIMEOUT_S) -> tuple[int, dict]:
    """(HTTP status, JSON body); raises RemoteError when the server cannot be reached. Tests replace this."""
    try:
        response = httpx.request(method, url, json=body, timeout=timeout)
    except httpx.HTTPError as exc:
        raise RemoteError(f"inversion server not reachable at {url} ({type(exc).__name__})") from exc
    try:
        payload = response.json()
    except ValueError:
        payload = {}
    return response.status_code, payload if isinstance(payload, dict) else {}


def _detail(status: int, body: dict) -> str:
    detail = body.get("detail") or body.get("error") or ""
    if isinstance(detail, list):   # FastAPI validation errors
        detail = "; ".join(str(d.get("msg", d)) if isinstance(d, dict) else str(d) for d in detail)
    return f"HTTP {status}" + (f": {detail}" if detail else "")


def server_status(refresh: bool = False) -> dict:
    """{available, url, workers?, reason?}; the health check is cached for HEALTH_TTL_S."""
    url = server_url()
    if url is None:
        return {"available": False, "url": None,
                "reason": f"no inversion server configured (set {ENV_URL} or backend/inversion_server.json)"}
    cached = _health_cache.get(url)
    if cached and not refresh and time.time() - cached[0] < HEALTH_TTL_S:
        return cached[1]
    try:
        status, body = _request("GET", f"{url}/health", timeout=HEALTH_TIMEOUT_S)
        info = {"available": status == 200, "url": url}
        if status != 200:
            info["reason"] = f"health check failed: {_detail(status, body)}"
        elif body.get("inversion_workers"):
            info["workers"] = body["inversion_workers"]
    except RemoteError as exc:
        info = {"available": False, "url": url, "reason": str(exc)}
    _health_cache[url] = (time.time(), info)
    return info


def start(job, force: bool) -> None:
    """Forward a proxy job's request to the server; on failure the job ends in a clear error."""
    url = server_url()
    job.started = time.time()
    if url is None:
        _fail(job, "no inversion server configured; run locally or set " + ENV_URL)
        return
    body = {**job.request, "run": job.run, "force": force}
    try:
        status, remote = _request("POST", f"{url}/inversion/jobs", body, timeout=SUBMIT_TIMEOUT_S)
    except RemoteError as exc:
        _health_cache.pop(url, None)
        _fail(job, str(exc))
        return
    if status != 200 or not remote.get("id"):
        _fail(job, f"inversion server rejected the job ({_detail(status, remote)})")
        return
    job.remote_id = remote["id"]
    _mirror(job, remote)


def poll(job) -> None:
    """Refresh an active proxy job from the server (at most once per POLL_INTERVAL_S, one poll at a time)."""
    if job.status not in ("queued", "running") or time.time() - job.polled < POLL_INTERVAL_S:
        return
    if not _poll_lock.acquire(blocking=False):
        return
    try:
        job.polled = time.time()
        url = server_url()
        if url is None:
            _fail(job, "inversion server no longer configured")
            return
        try:
            status, remote = _request("GET", f"{url}/inversion/jobs/{job.remote_id}")
        except RemoteError as exc:
            job.poll_failures += 1
            if job.poll_failures >= MAX_POLL_FAILURES:
                _fail(job, f"lost contact with the inversion server: {exc}")
            else:
                job.message = f"inversion server not answering, retrying ({job.poll_failures}/{MAX_POLL_FAILURES})"
            return
        if status == 404:
            _fail(job, f"the inversion server no longer knows job {job.remote_id} (restarted?)")
            return
        if status != 200:
            _fail(job, f"inversion server error ({_detail(status, remote)})")
            return
        job.poll_failures = 0
        _mirror(job, remote)
    finally:
        _poll_lock.release()


def _mirror(job, remote: dict) -> None:
    status = remote.get("status")
    if status in ("queued", "running"):
        job.status = status
        job.progress = min(float(remote.get("progress") or 0.0), 0.98)
        job.message = f"server: {remote.get('message') or status}"
        job.partial = remote.get("partial")
    elif status == "done" and remote.get("result") is not None:
        _finish(job, remote)
    elif status == "error":
        _fail(job, f"inversion failed on the server: {remote.get('error') or 'unknown error'}")
    else:
        _fail(job, f"unexpected job status from the inversion server: {status!r}")


def _finish(job, remote: dict) -> None:
    from backend.inversion import service   # service imports this module
    job.result, job.partial, job.finished = remote["result"], None, time.time()
    job.progress, job.message = 0.99, "saving to the local inversion store"
    job.force = False   # the server already replaced the stored result; here we only mirror it
    try:
        note = service.save_result(job)
    except Exception as exc:  # the result is still served from memory
        log.warning("could not save remote inversion %s: %s: %s", job.id, type(exc).__name__, str(exc)[:200])
        note = f"not saved locally ({type(exc).__name__})"
    how = "returned from the server's graph" if remote.get("source") == "graph" else "computed on the server"
    if remote.get("source") == "graph":
        job.source = "graph"
    job.status, job.progress = "done", 1.0
    job.message = how + (f"; {note}" if note else "")


def _fail(job, message: str) -> None:
    job.status, job.error, job.message, job.partial = "error", message, "failed", None
    job.finished = time.time()
