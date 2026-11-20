"""Remote inversion target: forwarding to the inversion server, status mirroring, result saving, errors. No network:
the HTTP call (remote._request) is replaced by a fake server."""

from __future__ import annotations

import unittest
from unittest import mock

from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.app import app
from backend.inversion import remote, service, store
from backend.inversion.api import InversionRequest


def fake_result(n=10):
    return {"well": "W-1", "md_ft": [1000.0 + 4 * i for i in range(n)], "stations": n, "curves": [],
            "model": {"layers": [], "boundary_tvd_ft": []}}


class FakeRun:
    def __init__(self):
        self.curves = {"ARH16P": None, "ARM16P": None}
        self.well = "W-1"


class FakeServer:
    """Answers remote._request like the inversion server would; ``down`` makes every call unreachable."""

    def __init__(self):
        self.calls = []
        self.down = False
        self.submit_reply = (200, {"id": "remote123456", "status": "queued", "progress": 0.0, "message": "waiting"})
        self.status_reply = (200, {"id": "remote123456", "status": "running", "progress": 0.4, "message": "slice 3"})
        self.health_reply = (200, {"status": "ok", "inversion_workers": 70})

    def __call__(self, method, url, body=None, timeout=None):
        self.calls.append((method, url, body))
        if self.down:
            raise remote.RemoteError(f"inversion server not reachable at {url} (ConnectError)")
        if url.endswith("/health"):
            return self.health_reply
        return self.submit_reply if method == "POST" else self.status_reply


class RemoteTargetTests(unittest.TestCase):
    URL = "http://inversion-server.test:8000"

    def setUp(self):
        self.store = store.MemoryStore()
        store.set_store(self.store)
        self.addCleanup(store.set_store, None)
        self.server = FakeServer()
        self._patch(remote, "_request", self.server)
        self._patch(remote, "POLL_INTERVAL_S", 0.0)
        self._patch(service, "run_inversion", mock.Mock(side_effect=AssertionError("must not run locally")))
        self._patch(remote, "_health_cache", {})
        env = mock.patch.dict("os.environ", {remote.ENV_URL: self.URL})
        env.start()
        self.addCleanup(env.stop)
        self.addCleanup(lambda: [service._jobs.pop(k, None) for k in list(service._jobs) if k in self.ids])
        self.ids = set()
        self.run = FakeRun()

    def _patch(self, obj, name, value):
        patcher = mock.patch.object(obj, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    def request(self):
        return {"curves": ["ARH16P", "ARM16P"], "md_min_ft": 1000.0, "md_max_ft": 1036.0, "step_ft": 4.0, "layers": 2,
                "calibration": True, "quick": True}

    def submit(self, force=False):
        job = service.submit("runR", self.run, self.request(), force=force, target="server")
        self.ids.add(job.id)
        return job

    def test_fingerprint_excludes_target(self):
        plan = {"used": [{"label": "ARH16P", "weight": 1.0}]}
        full = InversionRequest(run="r", **self.request(), target="server").model_dump()
        self.assertEqual(service.fingerprint("r", full, plan), service.fingerprint("r", self.request(), plan))
        with self.assertRaises(ValidationError):
            InversionRequest(run="r", **self.request(), target="cloud")

    def test_forwards_request_without_target(self):
        job = self.submit(force=True)
        method, url, body = self.server.calls[0]
        self.assertEqual((method, url), ("POST", f"{self.URL}/inversion/jobs"))
        self.assertNotIn("target", body)
        self.assertEqual((body["run"], body["force"], body["md_min_ft"]), ("runR", True, 1000.0))
        self.assertEqual((job.status, job.target, job.remote_id), ("queued", "server", "remote123456"))
        self.assertEqual(job.to_dict()["target"], "server")

    def test_status_is_mirrored_then_result_saved_locally(self):
        job = self.submit()
        got = service.get(job.id)
        self.assertEqual(self.server.calls[-1][:2], ("GET", f"{self.URL}/inversion/jobs/remote123456"))
        self.assertEqual((got.status, got.progress), ("running", 0.4))
        self.assertIn("slice 3", got.message)
        self.server.status_reply = (200, {"id": "remote123456", "status": "done", "progress": 1.0,
                                          "source": "computed", "result": fake_result()})
        done = service.get(job.id)
        self.assertEqual((done.status, done.result["stations"]), ("done", 10))
        self.assertIn("computed on the server", done.message)
        self.assertEqual(self.store.find(job.fingerprint)["result"]["stations"], 10)
        self.assertEqual([j.id for j in service.finished_jobs("runR")], [job.id])
        polls = len(self.server.calls)
        service.get(job.id)                                  # finished: no more polling
        self.assertEqual(len(self.server.calls), polls)

    def test_server_down_gives_clear_error(self):
        self.server.down = True
        job = self.submit()
        self.assertEqual(job.status, "error")
        self.assertIn("not reachable", job.error)

    def test_server_rejection_and_remote_failure_are_reported(self):
        self.server.submit_reply = (500, {"error": "boom"})
        job = self.submit()
        self.assertEqual(job.status, "error")
        self.assertIn("HTTP 500: boom", job.error)
        self.server.submit_reply = (200, {"id": "remote123456", "status": "queued"})
        self.server.status_reply = (200, {"id": "remote123456", "status": "error", "error": "ValueError: bad"})
        job = self.submit()
        self.assertEqual(service.get(job.id).status, "error")
        self.assertIn("ValueError: bad", job.error)

    def test_poll_failures_retry_then_error(self):
        job = self.submit()
        self.server.down = True
        for _ in range(remote.MAX_POLL_FAILURES - 1):
            self.assertEqual(service.get(job.id).status, "queued")
        self.assertEqual(service.get(job.id).status, "error")
        self.assertIn("lost contact", job.error)

    def test_cache_hit_does_not_forward(self):
        job = self.submit()
        self.server.status_reply = (200, {"id": "remote123456", "status": "done", "result": fake_result()})
        service.get(job.id)
        service._jobs.pop(job.id)
        calls = len(self.server.calls)
        again = self.submit()
        self.assertEqual((again.source, again.status, again.id), ("graph", "done", job.id))
        self.assertEqual(len(self.server.calls), calls)

    def test_targets_without_url(self):
        with mock.patch.dict("os.environ", {remote.ENV_URL: ""}), \
                mock.patch.object(remote, "CONFIG_PATH", remote.CONFIG_PATH.with_name("missing.json")):
            body = TestClient(app).get("/inversion/targets").json()
            job = self.submit()
        self.assertIn("no inversion server configured", job.error)
        self.assertEqual(body["local"], {"available": True, "workers": service.WORKERS})
        self.assertFalse(body["server"]["available"])
        self.assertIsNone(body["server"]["url"])
        self.assertIn(remote.ENV_URL, body["server"]["reason"])
        self.assertEqual(self.server.calls, [])

    def test_targets_with_healthy_and_down_server(self):
        body = TestClient(app).get("/inversion/targets").json()
        self.assertEqual(body["server"], {"available": True, "url": self.URL, "workers": 70})
        self.server.down = True
        self.assertTrue(remote.server_status()["available"])            # cached
        down = remote.server_status(refresh=True)
        self.assertFalse(down["available"])
        self.assertIn("not reachable", down["reason"])


if __name__ == "__main__":
    unittest.main()
