import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from reverie.gpu import GpuLock


class CliTest(unittest.TestCase):
    def setUp(self):
        d = Path(tempfile.mkdtemp())
        self.env = {**os.environ, "REVERIE_GPU_LOCK": str(d / "gpu.lock"), "REVERIE_GPU_YIELD": str(d / "gpu.yield"),
                    "REVERIE_GPU_ACTIVITY": str(d / "gpu.activity"), "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "python")}
        self.d = d

    def run_cli(self, *args, timeout=30):
        return subprocess.run([sys.executable, "-m", "reverie.gpu", *args], env=self.env, capture_output=True, text=True, timeout=timeout)

    def test_hold_runs_command_and_releases(self):
        r = self.run_cli("hold", "review", "--", sys.executable, "-c", "import sys; print('ran'); sys.exit(3)")
        self.assertEqual(r.returncode, 3)
        self.assertIn("ran", r.stdout)
        st = json.loads(self.run_cli("status").stdout)
        self.assertEqual(st["holder"], {})
        self.assertLess(st["idle_seconds"], 10)
        self.assertFalse(st["train_may_start"])

    def test_hold_train_blocked_by_recent_activity(self):
        self.run_cli("hold", "chat", "--", "true")
        r = self.run_cli("hold", "train", "--timeout", "0", "--", "true")
        self.assertEqual(r.returncode, 75)
        r = self.run_cli("hold", "train", "--min-idle", "0", "--", "true")
        self.assertEqual(r.returncode, 0)

    def test_hold_preempt(self):
        holder = subprocess.Popen(
            [sys.executable, "-m", "reverie.gpu", "hold", "train", "--min-idle", "0", "--preempt", "--",
             sys.executable, "-c", "import time; time.sleep(30)"], env=self.env)
        try:
            for _ in range(100):
                if json.loads(self.run_cli("status").stdout)["holder"].get("role") == "train":
                    break
                time.sleep(0.1)
            r = self.run_cli("hold", "chat", "--timeout", "15", "--", "true")
            self.assertEqual(r.returncode, 0)
            self.assertEqual(holder.wait(timeout=15), 143)
        finally:
            holder.kill()

    def test_hold_needs_command(self):
        r = self.run_cli("hold", "chat")
        self.assertNotEqual(r.returncode, 0)


class GpuLockTest(unittest.TestCase):
    def setUp(self):
        d = Path(tempfile.mkdtemp())
        self.paths = (d / "gpu.lock", d / "gpu.yield", d / "gpu.activity")

    def lock(self, role):
        return GpuLock(role, *self.paths)

    def test_acquire_release_and_holder(self):
        chat = self.lock("chat")
        self.assertEqual(chat.holder(), {})
        self.assertTrue(chat.acquire(timeout=0))
        self.assertEqual(self.lock("train").holder().get("role"), "chat")
        self.assertEqual(json.loads(self.paths[0].read_text())["pid"], os.getpid())
        chat.release()
        self.assertEqual(chat.holder(), {})
        self.assertGreater(self.lock("train").last_activity(), 0)

    def test_train_needs_idle_gpu(self):
        chat = self.lock("chat")
        chat.acquire(timeout=0)
        chat.release()
        train = self.lock("train")
        self.assertFalse(train.acquire(timeout=0, min_idle=1800))
        self.assertTrue(train.acquire(timeout=0, min_idle=0))
        train.release()
        self.assertLess(train.idle_seconds(), 5)   # train never counts as activity, chat did
        self.assertFalse(train.should_yield())

    def test_contention_asks_holder_to_yield(self):
        # a second process holds the lock as "train"; chat asks it to yield and times out politely
        lock_path, yield_path, act = self.paths
        code = (
            "import sys, time; sys.path.insert(0, %r); from reverie.gpu import GpuLock; from pathlib import Path\n"
            "l = GpuLock('train', Path(%r), Path(%r), Path(%r)); l.acquire(timeout=0); print('held', flush=True)\n"
            "while not l.should_yield(): time.sleep(0.05)\n"
            "l.release(); print('released', flush=True); time.sleep(2)\n"
        ) % (str(Path(__file__).resolve().parents[1] / "python"), str(lock_path), str(yield_path), str(act))
        proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(proc.stdout.readline().strip(), "held")
            chat = self.lock("chat")
            self.assertEqual(chat.holder().get("role"), "train")
            t0 = time.time()
            self.assertTrue(chat.acquire(timeout=10, poll=0.05))
            self.assertLess(time.time() - t0, 10)
            self.assertEqual(proc.stdout.readline().strip(), "released")
            self.assertFalse(yield_path.exists())
            chat.release()
        finally:
            proc.kill()
            proc.wait()

    def test_lower_priority_does_not_ask(self):
        chat = self.lock("chat")
        chat.acquire(timeout=0)
        train = self.lock("train")
        self.assertFalse(train.acquire(timeout=0.2, poll=0.05))
        self.assertFalse(self.paths[1].exists())
        chat.release()

    def test_stale_or_unreadable_state(self):
        lock_path, yield_path, act = self.paths
        train = self.lock("train")
        yield_path.write_text(json.dumps({"role": "chat", "at": time.time() - 10}))
        self.assertTrue(train.should_yield())
        yield_path.write_text(json.dumps({"role": "chat", "at": time.time() - 1000}))
        self.assertFalse(train.should_yield())                     # stale request is ignored
        yield_path.unlink()
        # a holder whose lock file is unreadable mid-write is never asked to yield
        review = self.lock("review")
        review.acquire(timeout=0)
        lock_path.write_text("")
        chat = self.lock("chat")
        self.assertFalse(chat.acquire(timeout=0.3, poll=0.05))
        self.assertFalse(yield_path.exists())
        review.release()

    def test_timeout_clears_own_yield_request(self):
        lock_path, yield_path, act = self.paths
        train = self.lock("train")
        train.acquire(timeout=0, min_idle=0)
        chat = self.lock("chat")
        self.assertFalse(chat.acquire(timeout=0.3, poll=0.05))
        self.assertFalse(yield_path.exists())                      # cleaned up on giving up
        train.release()

    def test_context_manager_and_bad_role(self):
        with self.lock("review") as r:
            self.assertEqual(self.lock("chat").holder().get("role"), "review")
        self.assertEqual(r.holder(), {})
        with self.assertRaises(ValueError):
            self.lock("gardening")


if __name__ == "__main__":
    unittest.main()
