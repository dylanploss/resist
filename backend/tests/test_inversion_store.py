"""Inversion store: contract (memory/snapshot, Cosmos when configured), service flow, snapshot, bindings, key.

Cosmos integration tests run only when ``COSMOS_GREMLIN_ENDPOINT`` is set (and the account is reachable); they write
to ``test|<uuid>`` partitions and drop them afterwards. The key-leak check runs when a key is available
(``COSMOS_GREMLIN_KEY``, or ``RESIST_KEY_LEAK_CHECK=1`` to fetch it with ``az``); it never prints the key.
"""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock
import uuid

from fastapi.testclient import TestClient

from backend.app import app
from backend.inversion import cosmos_config, graph_io, service, store
from backend.inversion.cosmos_store import CosmosStore, _status_of

REPO = Path(__file__).resolve().parents[2]


def make_result(md_min=1000.0, n=10, step=4.0, labels=("ARH16P", "ARM16P"), obs=1.5, boundaries=1):
    md = [md_min + step * i for i in range(n)]
    return {
        "well": "W-1", "md_ft": md, "tvd_ft": [500.0 + i for i in range(n)],
        "inclination_deg": [None] + [80.0] * (n - 1),
        "curves": [{"label": lab, "group": lab[2:5], "kind": "avg", "measurement": "phase", "unit": "ohm.m",
                    "used": True, "weight": 1.0, "obs": [None] + [obs] * (n - 1), "pred": [1.4] * n} for lab in labels],
        "model": {"layers": [{"rh": 1.0, "rv": 2.0, "top_tvd_ft": None, "bottom_tvd_ft": 505.0},
                             {"rh": 3.0, "rv": 4.0, "top_tvd_ft": 505.0, "bottom_tvd_ft": None}][:boundaries + 1],
                  "dip_deg": 1.0, "dip_azimuth_deg": 2.0, "reference_note": "n",
                  "boundary_tvd_ft": [[505.0] * n for _ in range(boundaries)]},
        "rms_percent_used": 1.0, "misfit_normalised": 1.0, "stations": n, "forward_evaluations": 3, "elapsed_s": 1.0,
    }


def make_record(run, fp=None, version="1", request_key="rk", finished=None, supersedes=(), **res):
    fp = fp or uuid.uuid4().hex * 2
    return {"fingerprint": fp, "job_id": fp[:12], "run": run, "version": version, "request_key": request_key,
            "request": {"md_min_ft": 1000.0, "md_max_ft": 1036.0, "layers": 2}, "plan": {"used": []},
            "result": make_result(**res), "created": 1.0, "started": 2.0, "finished": finished or time.time(),
            "supersedes": list(supersedes), "superseded": False}


class StoreContract:
    """Mixed into a TestCase that provides ``self.store`` and ``self.run``."""

    def test_find_returns_exact_record_after_save(self):
        rec = make_record(self.run)
        self.assertIsNone(self.store.find(rec["fingerprint"], run=self.run))
        self.store.save(rec)
        got = self.store.find(rec["fingerprint"], run=self.run)
        self.assertEqual(got["result"], rec["result"])
        self.assertEqual(got["request"], rec["request"])
        self.assertEqual(self.store.get(rec["job_id"])["fingerprint"], rec["fingerprint"])

    def test_list_newest_first_without_result(self):
        a = make_record(self.run, finished=100.0, request_key="a")
        b = make_record(self.run, finished=200.0, request_key="b")
        self.store.save(a)
        self.store.save(b)
        listed = self.store.list_finished(self.run)
        self.assertEqual([r["fingerprint"] for r in listed], [b["fingerprint"], a["fingerprint"]])
        self.assertNotIn("result", listed[0])
        self.assertEqual(listed[0]["summary"]["stations"], 10)
        self.assertEqual(listed[0]["summary"]["boundaries"], 1)

    def test_supersede_hides_older_version(self):
        old = make_record(self.run, version="1", finished=100.0)
        self.store.save(old)
        self.assertEqual(self.store.older_versions(self.run, "rk", "2"), [old["fingerprint"]])
        new = make_record(self.run, version="2", finished=200.0, supersedes=[old["fingerprint"]])
        self.store.save(new)
        self.assertEqual([r["fingerprint"] for r in self.store.list_finished(self.run)], [new["fingerprint"]])
        self.assertTrue(self.store.find(old["fingerprint"], run=self.run)["superseded"])
        self.assertEqual(self.store.older_versions(self.run, "rk", "2"), [])

    def test_delete_and_resave_replaces(self):
        rec = make_record(self.run)
        self.store.save(rec)
        self.store.delete(rec["fingerprint"], run=self.run)
        self.assertIsNone(self.store.find(rec["fingerprint"], run=self.run))
        rec2 = copy.deepcopy(rec)
        rec2["result"]["misfit_normalised"] = 9.0
        self.store.save(rec2)
        self.store.save(rec2)                      # idempotent re-save
        self.assertEqual(self.store.find(rec["fingerprint"], run=self.run)["result"]["misfit_normalised"], 9.0)
        self.assertEqual(len(self.store.list_finished(self.run)), 1)

    def test_overlapping_intervals_share_stations(self):
        self.store.save(make_record(self.run, md_min=1000.0, n=10, request_key="a"))   # 1000..1036
        self.store.save(make_record(self.run, md_min=1020.0, n=10, request_key="b"))   # 1020..1056
        self.assertEqual(self.store.count_stations(self.run), 15)                      # union, not 20


class MemoryStoreContract(StoreContract, unittest.TestCase):
    def setUp(self):
        self.store, self.run = store.MemoryStore(), "runA"


class SnapshotStoreContract(StoreContract, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "graph" / "inversions.json"
        self.store, self.run = store.SnapshotStore(self.path), "runA"

    def test_persists_across_instances(self):
        rec = make_record(self.run)
        self.store.save(rec)
        again = store.SnapshotStore(self.path)
        self.assertEqual(again.find(rec["fingerprint"])["result"], rec["result"])
        self.assertEqual(again.count_stations(self.run), 10)
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ["inversions.json"])   # no temp leftovers

    def test_write_is_sorted_and_stable(self):
        for fp in ("b" * 64, "a" * 64):
            self.store.save(make_record(self.run, fp=fp, request_key=fp))
        first = self.path.read_bytes()
        store.SnapshotStore(self.path)._write()
        self.assertEqual(self.path.read_bytes(), first)
        recs = json.loads(first)["records"]
        self.assertEqual([r["fingerprint"][0] for r in recs], ["a", "b"])


@unittest.skipUnless(os.environ.get("COSMOS_GREMLIN_ENDPOINT"), "Cosmos integration: set COSMOS_GREMLIN_ENDPOINT")
class CosmosStoreContract(StoreContract, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        settings = cosmos_config.resolve()
        if not settings.key:
            raise unittest.SkipTest(f"no Cosmos key: {settings.reason}")
        cls.cosmos = CosmosStore(settings)

    @classmethod
    def tearDownClass(cls):
        cls.cosmos.close()

    def setUp(self):
        self.store, self.run = self.cosmos, f"test|{uuid.uuid4().hex[:10]}"
        self.addCleanup(self.cosmos.drop_partition, self.run)

    def test_resave_gives_identical_counts(self):
        rec = make_record(self.run)
        self.store.save(rec)
        count = lambda: self.store.query("g.V().has('pk', pk).count()", {"pk": self.run})[0]
        before = count()
        self.store.save(rec)
        self.assertEqual(count(), before)


# --- service flow with a stubbed inversion ---------------------------------------------------------------------

class FakeRun:
    def __init__(self):
        self.curves = {"ARH16P": None, "ARM16P": None, "ARH32P": None}
        self.well = "W-1"


class ServiceFlowTests(unittest.TestCase):
    def setUp(self):
        self.store = store.MemoryStore()
        store.set_store(self.store)
        self.addCleanup(store.set_store, None)
        self.calls = []
        done = threading.Event()

        def fake_run_inversion(run, request, plan, job=None):
            self.calls.append(request)
            n = int((request["md_max_ft"] - request["md_min_ft"]) // request["step_ft"]) + 1
            return make_result(md_min=request["md_min_ft"], n=n, step=request["step_ft"])

        patcher = mock.patch.object(service, "run_inversion", side_effect=fake_run_inversion)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(lambda: [service._jobs.pop(k) for k in list(service._jobs) if k in self.ids])
        self.ids = set()
        self.run = FakeRun()

    def request(self, lo=1000.0, hi=1036.0, curves=("ARH16P", "ARM16P")):
        return {"curves": list(curves), "md_min_ft": lo, "md_max_ft": hi, "step_ft": 4.0, "layers": 2,
                "calibration": True, "quick": True}

    def run_job(self, req, force=False, run_id="runF"):
        job = service.submit(run_id, self.run, req, force=force)
        self.ids.add(job.id)
        for _ in range(200):
            if job.status in ("done", "error"):
                break
            time.sleep(0.01)
        self.assertEqual(job.status, "done", job.error)
        return job

    def test_fingerprint_is_stable_and_order_independent(self):
        plan = {"used": [{"label": "ARH16P", "weight": 1.0}]}
        a = service.fingerprint("r", self.request(curves=("ARH16P", "ARM16P")), plan)
        b = service.fingerprint("r", self.request(curves=("ARM16P", "ARH16P")), plan)
        self.assertEqual(a, b)
        v2 = service.fingerprint("r", self.request(), plan, version="99")
        self.assertNotEqual(a[0], v2[0])
        self.assertEqual(a[1], v2[1])                       # same request key across versions

    def test_same_request_twice_computes_once(self):
        first = self.run_job(self.request())
        self.assertEqual(first.source, "computed")
        t0 = time.time()
        second = service.submit("runF", self.run, self.request())
        self.assertLess(time.time() - t0, 2.0)
        self.assertEqual((second.source, second.status, second.id), ("graph", "done", first.id))
        self.assertEqual(second.result, first.result)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(second.to_dict()["source"], "graph")

    def test_force_recomputes_and_replaces(self):
        first = self.run_job(self.request())
        again = self.run_job(self.request(), force=True)
        self.assertEqual((again.source, again.id), ("computed", first.id))
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(self.store.list_finished("runF")), 1)

    def test_version_bump_supersedes(self):
        old = self.run_job(self.request())
        with mock.patch.object(service, "INVERSION_VERSION", "test-next"):
            new = self.run_job(self.request())
            self.assertNotEqual(new.id, old.id)
            self.assertIn("supersedes 1", new.message)
            service._jobs.pop(old.id, None)                 # as after a restart: only the store lists jobs
            listed = [j.id for j in service.finished_jobs("runF")]
        self.assertEqual(listed, [new.id])
        self.assertEqual(self.store.find(new.fingerprint)["supersedes"], [old.fingerprint])

    def test_overlapping_interval_reuses_stations(self):
        self.run_job(self.request(1000.0, 1036.0))
        self.run_job(self.request(1020.0, 1056.0))
        self.assertEqual(self.store.count_stations("runF"), 15)

    def test_stored_job_served_after_restart(self):
        job = self.run_job(self.request())
        service._jobs.clear()                               # restart: memory of running jobs is gone
        got = service.get(job.id)
        self.assertEqual((got.source, got.status), ("graph", "done"))
        self.assertEqual([j.id for j in service.finished_jobs("runF")], [job.id])


class ApiTests(unittest.TestCase):
    def test_health_reports_store_without_network(self):
        store.set_store(store.MemoryStore())
        self.addCleanup(store.set_store, None)
        body = TestClient(app).get("/health").json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["store"], "memory")
        self.assertTrue(body["cosmos"].startswith("disabled"))

    def test_default_store_is_snapshot_with_cosmos_disabled(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, {"RESIST_STORE": "", "COSMOS_ENABLED": "false"}), \
                mock.patch.object(store, "SNAPSHOT_PATH", Path(tmp) / "inversions.json"), \
                mock.patch.object(cosmos_config, "resolve", side_effect=AssertionError("no network")):
            store.set_store(None)
            self.addCleanup(store.set_store, None)
            st = store.status()
        self.assertEqual(st["store"], "snapshot")
        self.assertEqual(st["cosmos"], store.COSMOS_DISABLED)

    def test_enabled_but_unreachable_falls_back_with_reason(self):
        settings = cosmos_config.CosmosSettings(endpoint="wss://x/", reason="Azure CLI is not logged in")
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, {"RESIST_STORE": "", "COSMOS_ENABLED": "true"}), \
                mock.patch.object(store, "SNAPSHOT_PATH", Path(tmp) / "inversions.json"), \
                mock.patch.object(cosmos_config, "resolve", return_value=settings), \
                self.assertLogs("resist.store", "WARNING") as logs:
            store.set_store(None)
            self.addCleanup(store.set_store, None)
            store.get_store()
            st = store.status()
        self.assertEqual((st["store"], st["cosmos"]), ("snapshot", "unavailable"))
        self.assertIn("not logged in", st["reason"])
        self.assertIn("az login --tenant 704b7209-73fa-43f5-8e84-21cd65fe5697 --use-device-code", logs.output[0])

    def test_force_field_accepted(self):
        from backend.inversion.api import InversionRequest
        req = InversionRequest(run="r", curves=["ARH16P"], md_min_ft=1, md_max_ft=2, force=True)
        self.assertNotIn("force", req.model_dump(exclude={"force"}))


# --- snapshot round trip -----------------------------------------------------------------------------------------

class SnapshotRoundTripTests(unittest.TestCase):
    def test_export_import_counts_match_and_import_is_idempotent(self):
        src = store.MemoryStore()
        old = make_record("runA", version="1", finished=1.0)
        src.save(old)
        src.save(make_record("runA", version="2", finished=2.0, supersedes=[old["fingerprint"]]))
        src.save(make_record("runB", md_min=2000.0))
        src.save(make_record("test|x"))                     # test partitions never go into the snapshot
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "inversions.json"
            info = graph_io.export_snapshot(src, path)
            self.assertEqual(info["records"], 3)
            self.assertLess(info["bytes"], 50 * 1024 * 1024)
            dst = store.MemoryStore()
            self.assertEqual(graph_io.import_snapshot(dst, path), {"imported": 3, "skipped": 0})
            self.assertEqual(graph_io.import_snapshot(dst, path), {"imported": 0, "skipped": 3})
            self.assertEqual(len(dst.all_records()), 3)
            self.assertEqual([r["version"] for r in dst.list_finished("runA")], ["2"])
            self.assertEqual(dst.count_stations("runA"), src.count_stations("runA"))
            graph_io.export_snapshot(dst, Path(tmp) / "again.json")
            self.assertEqual((Path(tmp) / "again.json").read_bytes(), path.read_bytes())


# --- Cosmos client behaviour without Azure ----------------------------------------------------------------------

class RecordingClient:
    def __init__(self, fail_first=None):
        self.calls, self.fail_first = [], fail_first

    def submit(self, script, bindings):
        self.calls.append((script, dict(bindings)))
        if self.fail_first:
            exc, self.fail_first = self.fail_first, None
            raise exc
        result = []
        if "valueMap()" in script:
            result = []
        return mock.Mock(all=lambda: mock.Mock(result=lambda: result))

    def close(self):
        pass


class CosmosScriptTests(unittest.TestCase):
    def settings(self):
        return cosmos_config.CosmosSettings(endpoint="wss://x/", key="k")

    def test_scripts_use_bindings_only(self):
        client = RecordingClient()
        st = CosmosStore(self.settings(), client_factory=lambda: client)
        evil = "test|x'); g.V().drop(); //"
        rec = make_record(evil, labels=("ARH16P", "ZRH16PT"))
        rec["request"]["note"] = "') .drop() //"
        st.save(rec)
        st.list_finished(evil)
        st.older_versions(evil, "rk", "1")
        self.assertGreater(len(client.calls), 10)
        values = set()
        for _, b in client.calls:   # every binding that carries request data (labels like 'layer' are constants)
            values.update(str(v) for v in b.values() if isinstance(v, str) and ("test|x" in v or "drop()" in v))
        self.assertTrue(values)
        for script, _ in client.calls:
            for v in values:
                self.assertNotIn(v, script, "a request value was formatted into a Gremlin script")
            self.assertNotIn(evil, script)

    def test_retries_429_after_retry_after(self):
        from gremlin_python.driver.protocol import GremlinServerError
        err = GremlinServerError({"code": 500, "message": "throttled",
                                  "attributes": {"x-ms-status-code": 429, "x-ms-retry-after-ms": "1"}})
        self.assertEqual(_status_of(err), (429, 0.001))
        client = RecordingClient(fail_first=err)
        st = CosmosStore(self.settings(), client_factory=lambda: client)
        st.query("g.V(vid).count()", {"vid": "a"})
        self.assertEqual(len(client.calls), 2)

    def test_non_retryable_error_raises(self):
        from gremlin_python.driver.protocol import GremlinServerError
        err = GremlinServerError({"code": 500, "message": "bad", "attributes": {"x-ms-status-code": 400}})
        st = CosmosStore(self.settings(), client_factory=lambda: RecordingClient(fail_first=err))
        with self.assertRaises(GremlinServerError):
            st.query("g.V()", {})


# --- key resolution order -----------------------------------------------------------------------------------------

class KeyResolutionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.config = self.dir / "cosmos.config.json"
        self.config.write_text(json.dumps({"endpoint": "wss://acct.gremlin.cosmos.azure.com:443/", "account": "acct",
                                           "resource_group": "rg", "subscription_id": "sub",
                                           "database": "resist", "graph": "inversions"}))
        self.env_file = self.dir / ".env"

    def resolve(self, environ, run):
        with mock.patch.object(cosmos_config.shutil, "which", return_value="az"):
            return cosmos_config.resolve(environ=environ, env_file=self.env_file, config_file=self.config, run=run)

    def test_env_key_wins_and_az_is_not_called(self):
        run = mock.Mock(side_effect=AssertionError("az must not run"))
        s = self.resolve({"COSMOS_GREMLIN_KEY": "envkey"}, run)
        self.assertEqual((s.key, s.key_source), ("envkey", "env"))

    def test_env_file_key_used(self):
        self.env_file.write_text("# local\nCOSMOS_GREMLIN_KEY='filekey'\n")
        s = self.resolve({}, mock.Mock(side_effect=AssertionError("az must not run")))
        self.assertEqual((s.key, s.key_source), ("filekey", "env"))

    def test_az_fallback_with_subscription_and_timeout(self):
        run = mock.Mock(return_value=subprocess.CompletedProcess([], 0, stdout="azkey\n", stderr=""))
        s = self.resolve({}, run)
        self.assertEqual((s.key, s.key_source, s.reason), ("azkey", "az", None))
        cmd = run.call_args.args[0]
        self.assertEqual(cmd[:5], ["az", "cosmosdb", "keys", "list", "--subscription"])
        self.assertEqual(cmd[5], "sub")
        self.assertIn("primaryMasterKey", cmd)
        self.assertEqual(run.call_args.kwargs["timeout"], cosmos_config.AZ_TIMEOUT_S)
        self.assertNotIn("azkey", repr(s))                 # key never in repr/logs

    def test_az_not_logged_in_gives_reason(self):
        run = mock.Mock(return_value=subprocess.CompletedProcess([], 1, stdout="",
                                                                 stderr="ERROR: Please run 'az login' to setup account."))
        s = self.resolve({}, run)
        self.assertIsNone(s.key)
        self.assertIn("not logged in", s.reason)

    def test_az_permission_denied_and_timeout(self):
        run = mock.Mock(return_value=subprocess.CompletedProcess(
            [], 1, stdout="", stderr="(AuthorizationFailed) does not have authorization to perform action listKeys"))
        self.assertIn("permission", self.resolve({}, run).reason)
        run = mock.Mock(side_effect=subprocess.TimeoutExpired("az", 60))
        self.assertIn("timed out", self.resolve({}, run).reason)

    def test_az_missing(self):
        with mock.patch.object(cosmos_config.shutil, "which", return_value=None):
            s = cosmos_config.resolve(environ={}, env_file=self.env_file, config_file=self.config,
                                      run=mock.Mock(side_effect=AssertionError))
        self.assertIn("not installed", s.reason)


# --- secrets -------------------------------------------------------------------------------------------------------

class SecretTests(unittest.TestCase):
    def test_env_files_are_gitignored(self):
        for rel in ("backend/.env", ".env"):
            proc = subprocess.run(["git", "check-ignore", "-q", rel], cwd=REPO)
            self.assertEqual(proc.returncode, 0, f"{rel} is not gitignored")

    def test_tracked_config_has_no_key(self):
        cfg = json.loads((REPO / "backend" / "cosmos.config.json").read_text(encoding="utf-8-sig"))
        self.assertFalse({k for k in cfg if "key" in k.lower() and k != "partition_key"})
        self.assertFalse(cfg.get("enabled", False), "Cosmos stays disabled while the tenant policy blocks it")

    @unittest.skipUnless(os.environ.get("COSMOS_GREMLIN_KEY") or os.environ.get("RESIST_KEY_LEAK_CHECK"),
                         "needs a key: set COSMOS_GREMLIN_KEY or RESIST_KEY_LEAK_CHECK=1 (fetches with az)")
    def test_account_key_prefix_not_in_tracked_files(self):
        settings = cosmos_config.resolve()
        if not settings.key:
            self.skipTest(f"no key: {settings.reason}")
        prefix = settings.key[:8]
        proc = subprocess.run(["git", "grep", "-l", "-F", "-e", prefix, "--", "."], cwd=REPO,
                              capture_output=True, text=True)
        files = proc.stdout.split()
        self.assertEqual(files, [], f"the Cosmos account key prefix appears in tracked files: {files}")


if __name__ == "__main__":
    unittest.main()
