import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import json
import tempfile
import unittest
from pathlib import Path

from cto.train.config import TrainConfig
from cto.train.serve import ServeConfig, Server, dump_serve_config, load_serve_config
from cto.train.smoke import requirements
from cto.train.swap import CheckResult
from cto.train.train_qlora import latest_checkpoint, plan


class FakeProc:
    def __init__(self, pid):
        self.pid = pid


class FakeHost:
    """Pretends to be the OS and the llama-server HTTP API."""

    def __init__(self):
        self.started: list[list[str]] = []
        self.killed: list[int] = []
        self.adapters: list[dict] = []
        self.posts: list[list[dict]] = []
        self.healthy_after = 0
        self.fail_start = False
        self._health_calls = 0

    def popen(self, cmd, **kw):
        self.started.append(cmd)
        paths = [cmd[i + 1] for i, a in enumerate(cmd) if a == "--lora"]
        self.adapters = [{"id": i, "path": p, "scale": 0.0} for i, p in enumerate(paths)]
        self._health_calls = 0
        return FakeProc(1000 + len(self.started))

    def http(self, method, url, body):
        if url.endswith("/health"):
            self._health_calls += 1
            ok = not self.fail_start and self._health_calls > self.healthy_after
            return json.dumps({"status": "ok" if ok else "loading"}).encode()
        if url.endswith("/lora-adapters"):
            if method == "POST":
                scales = json.loads(body)
                self.posts.append(scales)
                for s in scales:
                    self.adapters[s["id"]]["scale"] = s["scale"]
            return json.dumps(self.adapters).encode()
        raise AssertionError(url)

    def sleep(self, s):
        pass


def make_server(host, tmp):
    cfg = ServeConfig(llama_server="llama-server", model_path="/m.gguf", state_path=tmp / "serve.json", health_timeout=1)
    srv = Server(cfg, popen=host.popen, http=host.http, sleep=host.sleep)
    srv.stop = lambda: (host.killed.append(srv.state().get("pid")), srv._save(None, srv.state().get("adapters", []), None), True)[2]
    return srv


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.host = FakeHost()
        self.srv = make_server(self.host, self.tmp)

    def test_command_and_config_roundtrip(self):
        cfg = self.srv.cfg
        cmd = cfg.command(["/a.gguf", "/b.gguf"])
        self.assertEqual(cmd[:5], ["llama-server", "--host", "127.0.0.1", "--port", "8081"])
        self.assertEqual(cmd[5], "--alias")
        self.assertIn("--lora-init-without-apply", cmd)
        self.assertEqual(cmd.count("--lora"), 2)
        self.assertNotIn("--lora", cfg.command([]))
        p = self.tmp / "serve.json.cfg"
        p.write_text(dump_serve_config(cfg))
        back = load_serve_config(p)
        self.assertEqual(back.port, 8081)
        self.assertEqual(back.state_path, cfg.state_path)
        self.assertEqual(load_serve_config(None).port, 8081)

    def test_start_records_state_and_activates(self):
        pid = self.srv.start(["/a.gguf"], active="/a.gguf")
        self.assertEqual(pid, 1001)
        st = self.srv.state()
        self.assertEqual(st["adapters"], ["/a.gguf"])
        self.assertEqual(st["active"], "/a.gguf")
        self.assertEqual(self.host.posts[-1], [{"id": 0, "scale": 1.0}])
        self.assertTrue(self.srv.healthy())

    def test_start_failure(self):
        self.host.fail_start = True
        with self.assertRaises(RuntimeError):
            self.srv.start([])
        self.assertIsNone(self.srv.state()["pid"])

    def test_swap_success(self):
        self.srv.start(["/old.gguf"], active="/old.gguf")
        res = self.srv.swap("/new.gguf", lambda: CheckResult(True, ["fine"]))
        self.assertTrue(res.ok)
        self.assertEqual(self.host.killed, [1001])
        self.assertEqual(self.host.started[-1].count("--lora"), 2)
        st = self.srv.state()
        self.assertEqual(st["adapters"], ["/new.gguf", "/old.gguf"])
        self.assertEqual(st["active"], "/new.gguf")
        self.assertEqual(self.host.adapters[0]["scale"], 1.0)
        self.assertEqual(self.host.adapters[1]["scale"], 0.0)

    def test_swap_rollback_by_scales(self):
        self.srv.start(["/old.gguf"], active="/old.gguf")
        res = self.srv.swap("/new.gguf", lambda: CheckResult(False, [], "profanity in reply"))
        self.assertFalse(res.ok)
        self.assertTrue(res.reason.startswith("rolled back (scales)"))
        self.assertEqual(self.host.adapters[0]["scale"], 0.0)   # new off
        self.assertEqual(self.host.adapters[1]["scale"], 1.0)   # old back on
        self.assertEqual(self.srv.state()["active"], "/old.gguf")

    def test_swap_rollback_by_restart_when_new_server_fails(self):
        self.srv.start(["/old.gguf"], active="/old.gguf")
        calls = {"n": 0}
        real_popen = self.host.popen

        def popen(cmd, **kw):
            calls["n"] += 1
            self.host.fail_start = calls["n"] == 1   # the restart with the new adapter never gets healthy
            return real_popen(cmd, **kw)

        self.srv._popen = popen
        res = self.srv.swap("/new.gguf", lambda: CheckResult(True, []))
        self.assertFalse(res.ok)
        self.assertTrue(res.reason.startswith("rolled back (restart)"))
        self.assertEqual(self.srv.state()["adapters"], ["/old.gguf"])
        self.assertEqual(self.srv.state()["active"], "/old.gguf")


class TrainHelpersTest(unittest.TestCase):
    def test_latest_checkpoint(self):
        d = Path(tempfile.mkdtemp())
        self.assertIsNone(latest_checkpoint(d / "none"))
        for n in (5, 10, 15):
            (d / f"checkpoint-{n}").mkdir()
        (d / "checkpoint-junk").mkdir()
        self.assertEqual(latest_checkpoint(d).name, "checkpoint-15")
        cfg = TrainConfig(output_root=str(d), run_name="r")
        (d / "r" / "checkpoints" / "checkpoint-3").mkdir(parents=True)
        self.assertTrue(plan(cfg)["resume_from"].endswith("checkpoint-3"))
        self.assertEqual(plan(cfg)["optim"], "paged_adamw_8bit")

    def test_snapshot_markers(self):
        from cto.train.train_qlora import snapshot_base, snapshot_ready

        d = Path(tempfile.mkdtemp())
        self.assertFalse(snapshot_ready(d))
        (d / "config.json").write_text("{}")
        self.assertFalse(snapshot_ready(d))
        (d / "snapshot-base.json").write_text(json.dumps({"base_model": "x/y"}))
        self.assertTrue(snapshot_ready(d))
        self.assertEqual(snapshot_base(d), "x/y")
        cfg = TrainConfig(base_model="x/y", base_4bit_dir=str(d), output_root=str(d / "out"))
        self.assertEqual(plan(cfg)["base_4bit_snapshot"], str(d))
        self.assertEqual(plan(TrainConfig(base_model="other", base_4bit_dir=str(d), output_root=str(d / "out")))["base_4bit_snapshot"], "")

    def test_smoke_requirements(self):
        from unittest import mock

        from cto.train.smoke import hf_home

        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(hf_home(), Path.home() / ".cache" / "huggingface")
        with mock.patch.dict("os.environ", {"HF_HOME": "/x/hf"}):
            self.assertEqual(hf_home(), Path("/x/hf"))
        req = requirements(TrainConfig())
        self.assertEqual(req["download_gb_estimate"], 54.0)
        self.assertEqual(req["steps"], 20)
        self.assertGreater(req["free_gb_at_hf_home"], 0)
        self.assertEqual(requirements(TrainConfig(base_model="Qwen/Qwen3.5-9B"))["download_gb_estimate"], 18.0)


if __name__ == "__main__":
    unittest.main()
