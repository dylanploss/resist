#!/usr/bin/env bash
# Bootstrap the RESIST grid VM (Ubuntu 22.04): python3.12, build tools, Azure CLI, /opt/resist venv.
# Idempotent. Run as the admin user with sudo rights: bash bootstrap.sh /tmp/resist.bundle
set -euo pipefail
BUNDLE="${1:-/tmp/resist.bundle}"
APP=/opt/resist
SUB=2668e2c1-a6ab-42da-8bcf-edd50a6fc470
export DEBIAN_FRONTEND=noninteractive

if ! command -v python3.12 >/dev/null; then
  sudo -E apt-get update -q
  sudo -E apt-get install -yq software-properties-common
  sudo -E add-apt-repository -y ppa:deadsnakes/ppa
  sudo -E apt-get update -q
  sudo -E apt-get install -yq python3.12 python3.12-venv python3.12-dev build-essential git
fi
if ! command -v az >/dev/null; then
  curl -sL https://aka.ms/InstallAzureCLIDeb | sudo -E bash
fi

sudo mkdir -p "$APP" && sudo chown "$(id -u):$(id -g)" "$APP"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q "$BUNDLE" HEAD
  git -C "$APP" checkout -q --detach FETCH_HEAD
else
  git clone -q "$BUNDLE" "$APP.tmp" && cp -a "$APP.tmp/." "$APP/" && rm -rf "$APP.tmp"
  git -C "$APP" checkout -q --detach HEAD
fi
git -C "$APP" log --oneline -1

[ -x "$APP/.venv/bin/python" ] || python3.12 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install -q --upgrade pip
"$APP/.venv/bin/pip" install -q -r "$APP/backend/requirements.txt"

# Managed identity -> Cosmos key via `az cosmosdb keys list` (backend/inversion/cosmos_config.py).
# Without the role assignment the identity sees no subscription; run-grid.ps1 then passes the key over SSH stdin.
az account show -o none 2>/dev/null || az login --identity --allow-no-subscriptions -o none
az account set --subscription "$SUB" 2>/dev/null || echo "WARNING: VM identity has no access to $SUB (role assignment missing)"
echo "bootstrap ok: $(nproc) CPUs, $("$APP/.venv/bin/python" --version)"
