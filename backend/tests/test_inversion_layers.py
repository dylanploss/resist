import os
import time
import unittest
from unittest import mock

from fastapi.testclient import TestClient
import numpy as np

from backend.app import app
from backend.inversion import layers, service
from backend.inversion.adr_forward import FT


def fake_result(dip_deg=0.0, dip_azimuth_deg=0.0):
    return {
        "md_ft": [100.0, 104.0, 108.0],
        "tvd_ft": [5000.0, 5001.0, 5002.0],
        "model": {
            "layers": [{"rh": 2.0, "rv": 3.0}, {"rh": 20.0, "rv": 30.0}, {"rh": 5.0, "rv": 6.0}],
            "dip_deg": dip_deg, "dip_azimuth_deg": dip_azimuth_deg,
            # boundary 0 above the well; boundary 1 below, crossing out of range at the last station (null).
            "boundary_tvd_ft": [[4990.0, 4990.0, 4990.0], [5004.0, 5002.5, None]],
        },
    }


class BoundaryGeometryTests(unittest.TestCase):
    def test_flat_layers_distance_is_vertical_offset(self):
        g = layers.boundary_geometry(fake_result())
        np.testing.assert_allclose(g["normal_ned"], [0, 0, 1], atol=1e-12)
        top, bottom = g["boundaries"]
        self.assertEqual(top["above"], [True, True, True])
        self.assertAlmostEqual(top["distance_m"][0], 10 * FT, places=3)
        self.assertEqual(bottom["above"], [False, False, None])
        self.assertIsNone(bottom["distance_m"][2])
        self.assertEqual((top["rh_above"], top["rh_below"], bottom["rh_below"]), (2.0, 20.0, 5.0))

    def test_nearest_boundary_per_station(self):
        g = layers.boundary_geometry(fake_result())["nearest"]
        self.assertEqual(g["boundary"], [1, 1, 0])
        self.assertEqual(g["above"], [False, False, True])
        self.assertAlmostEqual(g["distance_m"][1], 1.5 * FT, places=3)

    def test_dip_shortens_perpendicular_distance(self):
        g = layers.boundary_geometry(fake_result(dip_deg=60.0, dip_azimuth_deg=90.0))
        n = np.array(g["normal_ned"])
        self.assertAlmostEqual(np.linalg.norm(n), 1.0)
        self.assertAlmostEqual(n[2], 0.5)
        # Plane dips toward east: the normal leans west (negative E), no N component.
        self.assertAlmostEqual(n[0], 0.0)
        self.assertLess(n[1], 0)
        self.assertAlmostEqual(g["boundaries"][0]["distance_m"][0], 10 * FT * 0.5, places=3)


class LayersApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def add_job(self, job_id, run, status="done", result=None, finished=None):
        job = service.Job(job_id, run, {"md_min_ft": 100.0, "md_max_ft": 108.0, "layers": 3}, {"used": []},
                          status=status, result=result, finished=finished)
        with service._jobs_lock:
            service._jobs[job_id] = job
        self.addCleanup(lambda: service._jobs.pop(job_id, None))
        return job

    def test_lists_finished_jobs_of_run_newest_first(self):
        now = time.time()
        self.add_job("t_old", "runA", result=fake_result(), finished=now - 10)
        self.add_job("t_new", "runA", result=fake_result(), finished=now)
        self.add_job("t_busy", "runA", status="running")
        self.add_job("t_other", "runB", result=fake_result(), finished=now)
        jobs = self.client.get("/inversion/jobs", params={"run": "runA"}).json()["jobs"]
        self.assertEqual([j["id"] for j in jobs], ["t_new", "t_old"])
        self.assertEqual(jobs[0]["boundaries"], 2)
        self.assertNotIn("result", jobs[0])

    def test_layers_endpoint(self):
        self.add_job("t_done", "runA", result=fake_result(), finished=time.time())
        body = self.client.get("/inversion/jobs/t_done/layers").json()
        self.assertEqual(body["id"], "t_done")
        self.assertEqual(len(body["boundaries"]), 2)
        self.assertEqual(body["nearest"]["boundary"], [1, 1, 0])

    def test_layers_endpoint_errors(self):
        self.add_job("t_run", "runA", status="running")
        self.assertEqual(self.client.get("/inversion/jobs/t_run/layers").status_code, 409)
        self.assertEqual(self.client.get("/inversion/jobs/nope/layers").status_code, 404)


class WorkerForwardingTests(unittest.TestCase):
    def test_jobs_go_to_the_worker_and_errors_keep_their_status(self):
        client = TestClient(app)
        calls = []

        def fake_request(method, url, **kwargs):
            calls.append((method, url, kwargs.get("json"), kwargs.get("params")))
            if url.endswith("/inversion/jobs/missing"):
                return mock.Mock(status_code=404, json=lambda: {"error": "unknown inversion job: missing"})
            return mock.Mock(status_code=200, json=lambda: {"id": "w1", "status": "queued"})

        body = {"run": "runA", "curves": ["ARM16P"], "md_min_ft": 100.0, "md_max_ft": 140.0}
        with mock.patch.dict(os.environ, {"RESIST_WORKER_URL": "http://gpu:5000/"}), \
                mock.patch("backend.inversion.remote.httpx.request", side_effect=fake_request):
            self.assertEqual(client.post("/inversion/jobs", json=body).json()["id"], "w1")
            self.assertEqual(client.get("/inversion/jobs/w1").json()["status"], "queued")
            missing = client.get("/inversion/jobs/missing")
        self.assertEqual(missing.status_code, 404)
        self.assertIn("unknown inversion job", missing.json()["error"])
        self.assertEqual(calls[0][:2], ("POST", "http://gpu:5000/inversion/jobs"))
        self.assertEqual(calls[0][2]["md_max_ft"], 140.0)
        self.assertEqual(calls[1][:2], ("GET", "http://gpu:5000/inversion/jobs/w1"))


if __name__ == "__main__":
    unittest.main()
