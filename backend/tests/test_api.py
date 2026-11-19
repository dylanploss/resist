from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from backend.app import app
from backend.qc.selection import SELECT_RANGE
from backend.services import runs

RUN = "2_4-VC-2_Y3H_16634-17888ft_RES_GEOSIGNAL"

client = TestClient(app)


@pytest.fixture
def real_data(monkeypatch):
    if not (runs.REPO_ROOT / "data" / f"{RUN}.dlis").is_file():
        pytest.skip("Ekofisk DLIS data not present")
    monkeypatch.delenv("DATA_DIR", raising=False)


@pytest.fixture
def no_data(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "missing"))


def test_health_returns_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_runs_lists_dlis_files(real_data) -> None:
    response = client.get("/runs")
    assert response.status_code == 200
    listed = {r["run"]: r for r in response.json()["runs"]}
    assert RUN in listed
    assert listed[RUN]["label"] == RUN.removesuffix("_RES_GEOSIGNAL")
    assert listed[RUN]["well"] == "2/4-VC-2 Y3H"
    assert listed[RUN]["depth_min_m"] < listed[RUN]["depth_max_m"]


def test_curves_returns_metadata_rows(real_data) -> None:
    response = client.get("/curves", params={"run": RUN})
    assert response.status_code == 200
    body = response.json()
    assert body["run"] == RUN
    rows = {r["curve"]: r for r in body["curves"]}
    assert "DEPT" in rows
    for row in rows.values():
        assert {"curve", "unit", "null_value", "description", "family"} <= set(row)
    resistivity = next(r for r in rows.values() if r["family"] in ("AR", "ZR"))
    assert resistivity["frequency_hz"] in (125_000, 500_000, 2_000_000)
    assert isinstance(resistivity["spacing_in"], int)


def test_curve_data_returns_depth_aligned_values(real_data) -> None:
    curves = client.get("/curves", params={"run": RUN}).json()["curves"]
    name = next(r["curve"] for r in curves if r["family"] == "AR")
    response = client.get(f"/curves/{RUN}/data", params={"curves": name})
    assert response.status_code == 200
    body = response.json()
    assert len(body["curves"][name]["values"]) == len(body["depth_m"])


def test_curves_requires_run() -> None:
    response = client.get("/curves")
    assert response.status_code == 400
    assert "error" in response.json()


def test_unknown_run_is_404(real_data) -> None:
    for response in (client.get("/curves", params={"run": "nope"}),
                     client.post("/qc/select", json={"run": "nope"})):
        assert response.status_code == 404
        assert response.json() == {"error": "unknown run: nope"}


def test_missing_data_dir_is_503(no_data) -> None:
    for response in (client.get("/runs"), client.get("/curves", params={"run": RUN})):
        assert response.status_code == 503
        assert "data directory not found" in response.json()["error"]


def test_qc_select_returns_contract_shape(real_data) -> None:
    response = client.post("/qc/select", json={"run": RUN, "n_select": 8})
    assert response.status_code == 200
    body = response.json()
    inventory = {r["curve"] for r in client.get("/curves", params={"run": RUN}).json()["curves"]}
    rejected = [r["curve"] for r in body["rejected"]]
    assert SELECT_RANGE[0] <= len(body["selected"]) <= SELECT_RANGE[1]
    assert sorted(body["selected"] + rejected) == sorted(inventory)
    assert set(body["scores"]) == inventory


@pytest.mark.parametrize("n_select", [SELECT_RANGE[0] - 1, SELECT_RANGE[1] + 1])
def test_qc_select_rejects_out_of_range(n_select: int) -> None:
    response = client.post("/qc/select", json={"run": RUN, "n_select": n_select})
    assert response.status_code == 400
    assert "n_select" in response.json()["error"]


def test_qc_select_requires_run() -> None:
    response = client.post("/qc/select", json={})
    assert response.status_code == 422
    assert "error" in response.json()
