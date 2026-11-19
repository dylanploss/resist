"""Connection settings for the shared Cosmos DB (Gremlin) graph.

Non-secret settings live in the tracked ``backend/cosmos.config.json`` (written by ``infra/cosmos-graph.ps1``).
Environment variables (or ``backend/.env``) override them: ``COSMOS_GREMLIN_ENDPOINT``, ``COSMOS_DATABASE``,
``COSMOS_GRAPH`` and ``COSMOS_GREMLIN_KEY``.

The account key is resolved in this order and kept in memory only (never written to disk, never logged):

1. ``COSMOS_GREMLIN_KEY`` from the environment or ``backend/.env``;
2. ``az cosmosdb keys list`` with the caller's own Azure CLI login (Contoso tenant).

If neither works, ``resolve`` returns a ``CosmosSettings`` with ``key=None`` and a human-readable ``reason``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import shutil
import subprocess

BACKEND_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BACKEND_DIR / "cosmos.config.json"
ENV_PATH = BACKEND_DIR / ".env"
AZ_TIMEOUT_S = 60
LOGIN_HINT = "run: az login --tenant 704b7209-73fa-43f5-8e84-21cd65fe5697 --use-device-code"


@dataclass
class CosmosSettings:
    endpoint: str | None = None
    database: str = "resist"
    graph: str = "inversions"
    account: str | None = None
    resource_group: str | None = None
    subscription_id: str | None = None
    tenant_id: str | None = None
    key: str | None = field(default=None, repr=False)   # never in repr/logs
    key_source: str | None = None                       # "env" | "az" | None
    reason: str | None = None                           # why the key is missing

    @property
    def username(self) -> str:
        return f"/dbs/{self.database}/colls/{self.graph}"


def read_env_file(path: Path = ENV_PATH) -> dict[str, str]:
    """Minimal KEY=VALUE parser (comments and blank lines ignored, optional quotes stripped)."""
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def read_config(path: Path = CONFIG_PATH) -> dict:
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _classify_az_error(stderr: str) -> str:
    s = stderr.lower()
    if "az login" in s or "not logged in" in s or "aadsts" in s or "expired" in s or "refresh token" in s:
        return "Azure CLI is not logged in to the Contoso tenant (or the token expired)"
    if "authorizationfailed" in s or "does not have authorization" in s or "listkeys" in s:
        return "your Azure account has no permission to list the Cosmos DB keys (listKeys)"
    if "subscription" in s and ("not found" in s or "could not be found" in s or "doesn't exist" in s):
        return "the Contoso subscription is not visible to this Azure CLI login (wrong tenant?)"
    if "resourcenotfound" in s or "was not found" in s:
        return "the Cosmos DB account was not found in the resource group"
    first = next((ln.strip() for ln in stderr.splitlines() if ln.strip()), "unknown error")
    return f"az cosmosdb keys list failed: {first[:200]}"


def fetch_key_with_az(settings: CosmosSettings, run=subprocess.run) -> tuple[str | None, str | None]:
    """(key, None) on success, (None, reason) on failure. The key is only returned, never printed."""
    if not (settings.account and settings.resource_group):
        return None, "cosmos.config.json has no account/resource_group"
    az = shutil.which("az")
    if az is None:
        return None, "Azure CLI (az) is not installed or not on PATH"
    cmd = [az, "cosmosdb", "keys", "list", "-g", settings.resource_group, "-n", settings.account,
           "--type", "keys", "--query", "primaryMasterKey", "-o", "tsv"]
    if settings.subscription_id:
        cmd[4:4] = ["--subscription", settings.subscription_id]
    try:
        proc = run(cmd, capture_output=True, text=True, timeout=AZ_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None, f"az cosmosdb keys list timed out after {AZ_TIMEOUT_S} s"
    except OSError as exc:
        return None, f"could not run az: {type(exc).__name__}"
    key = (proc.stdout or "").strip()
    if proc.returncode != 0 or not key:
        return None, _classify_az_error(proc.stderr or "")
    return key, None


def resolve(environ=None, env_file: Path = ENV_PATH, config_file: Path = CONFIG_PATH,
            run=subprocess.run) -> CosmosSettings:
    env = {**read_env_file(env_file), **(os.environ if environ is None else environ)}
    cfg = read_config(config_file)
    s = CosmosSettings(
        endpoint=env.get("COSMOS_GREMLIN_ENDPOINT") or cfg.get("endpoint"),
        database=env.get("COSMOS_DATABASE") or cfg.get("database") or "resist",
        graph=env.get("COSMOS_GRAPH") or cfg.get("graph") or "inversions",
        account=cfg.get("account"), resource_group=cfg.get("resource_group"),
        subscription_id=cfg.get("subscription_id"), tenant_id=cfg.get("tenant_id"))
    if not s.endpoint:
        s.reason = "no Cosmos endpoint configured (backend/cosmos.config.json or COSMOS_GREMLIN_ENDPOINT)"
        return s
    if env.get("COSMOS_GREMLIN_KEY"):
        s.key, s.key_source = env["COSMOS_GREMLIN_KEY"], "env"
        return s
    key, reason = fetch_key_with_az(s, run=run)
    if key:
        s.key, s.key_source = key, "az"
    else:
        s.reason = reason
    return s
