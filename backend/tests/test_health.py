from fastapi.testclient import TestClient

from app import app

client = TestClient(app)


def test_health_returns_ok() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_curves_returns_inventory_shape() -> None:
    response = client.get("/curves")
    assert response.status_code == 200
    assert response.json() == {"curves": []}


def test_qc_select_returns_contract_shape() -> None:
    response = client.post("/qc/select", json={"curves": ["RT"]})
    assert response.status_code == 200
    assert set(response.json()) == {"selected", "rejected", "scores"}
