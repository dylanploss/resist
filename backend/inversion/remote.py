"""Forward inversion jobs to a remote GPU worker running this same backend (``RESIST_WORKER_URL``).

The worker (``deploy/gpu-worker``) serves the normal API with ``RESIST_COMPUTE=jax`` on a GPU and reads the DLIS
files from its own ``DATA_DIR``. Reach it through an SSH tunnel, e.g. ``ssh -N -L 5001:localhost:5000 azureuser@vm``
and ``RESIST_WORKER_URL=http://localhost:5001``; the worker port is never exposed publicly. Plans stay local.
"""

from __future__ import annotations

import os

import httpx
from fastapi import HTTPException

TIMEOUT_S = 30.0


def worker_url() -> str | None:
    url = os.environ.get("RESIST_WORKER_URL", "").strip().rstrip("/")
    return url or None


def call(method: str, path: str, **kwargs) -> dict:
    """``method`` ``path`` on the worker; worker HTTP errors are re-raised with their status and detail."""
    url = worker_url()
    try:
        resp = httpx.request(method, f"{url}{path}", timeout=TIMEOUT_S, **kwargs)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"GPU worker {url} unreachable: {exc}") from exc
    if resp.status_code >= 400:
        try:
            body = resp.json()
            detail = body.get("error") or body.get("detail") or resp.text      # the worker app sends {"error": ...}
        except ValueError:
            detail = resp.text
        raise HTTPException(resp.status_code, detail)
    return resp.json()
