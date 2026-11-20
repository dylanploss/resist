"""The VM inversion server is called server-to-server (local backend -> VM), not from a browser."""

from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import app

ROOT = Path(__file__).resolve().parents[1].parent


def test_cors_does_not_block_server_to_server_calls():
    client = TestClient(app)
    assert client.get("/health").status_code == 200                                        # no Origin header
    r = client.get("/health", headers={"Origin": "http://10.0.0.5:5000"})                  # foreign Origin
    assert r.status_code == 200 and "access-control-allow-origin" not in r.headers


def test_backend_host_and_port_from_environment():
    src = (ROOT / "backend/app.py").read_text()
    assert 'os.environ.get("RESIST_BACKEND_HOST", "127.0.0.1")' in src
    assert 'os.environ.get("RESIST_BACKEND_PORT", "5000")' in src
