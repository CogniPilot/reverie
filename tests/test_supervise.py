import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import contextlib
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SUPERVISE = Path(__file__).resolve().parent.parent / "cto" / "supervise.py"


def wait_for(predicate, timeout=15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("condition not met in time")


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.state = self.tmp / "state"
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()
                p.wait()

    def child_script(self, body: str) -> Path:
        path = self.tmp / "child.py"
        path.write_text(body)
        return path

    def supervise(self, child: Path, *extra):
        env = {k: v for k, v in os.environ.items() if k != "FLEET_RUNTIME_POLICY"}
        proc = subprocess.Popen([sys.executable, str(SUPERVISE), "run", "--state", str(self.state), "--fast-seconds", "2",
                                 "--max-backoff", "0.5", "--grace", "2", *extra, "--", sys.executable, str(child)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        self.procs.append(proc)
        return proc

    def child(self):
        try:
            return json.loads((self.state / "child.json").read_text())
        except (OSError, ValueError):
            return None

    def alive(self, pid):
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def log(self):
        try:
            return (self.state / "supervise.log").read_text()
        except OSError:
            return ""

    LONG_RUNNING = "import time, signal, sys\nsignal.signal(signal.SIGTERM, lambda *a: sys.exit(0))\ntime.sleep(600)\n"

    def test_restart_replaces_the_console_and_keeps_the_supervisor(self):
        sup = self.supervise(self.child_script(self.LONG_RUNNING))
        first = wait_for(lambda: self.child() and self.child()["pid"])
        for _ in range(3):
            before = self.child()["pid"]
            out = subprocess.run([sys.executable, str(SUPERVISE), "restart", "--state", str(self.state)],
                                 capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertNotEqual(self.child()["pid"], before)
            self.assertFalse(self.alive(before))
        self.assertIsNone(sup.poll())                                           # the container's process stays
        self.assertEqual(self.log().count("restarted_on_request"), 3)
        self.assertNotEqual(self.child()["pid"], first)

    def test_a_killed_console_comes_back(self):
        sup = self.supervise(self.child_script(self.LONG_RUNNING))
        pid = wait_for(lambda: self.child() and self.child()["pid"])
        time.sleep(2.5)                                                         # past the fast-failure window
        os.kill(pid, signal.SIGKILL)
        wait_for(lambda: self.child()["pid"] != pid)
        self.assertIsNone(sup.poll())
        self.assertIn("exited code=-9", self.log())

    def test_a_console_that_keeps_failing_is_rolled_back_once_then_alerts(self):
        dist = self.tmp / "dist"
        dist.mkdir()
        (dist / "build").write_text("new")
        prev = self.tmp / "dist.prev"
        prev.mkdir()
        (prev / "build").write_text("old")
        sup = self.supervise(self.child_script("raise SystemExit(3)\n"), "--rollback-dist", str(dist))
        wait_for(lambda: "rolled_back" in self.log())
        self.assertEqual((dist / "build").read_text(), "old")                  # the previous build is back
        self.assertFalse(prev.exists())
        self.assertEqual(len(list(self.tmp.glob("dist.failed-*"))), 1)          # the failed one is kept
        wait_for(lambda: (self.state / "ALERT").exists())                       # still failing: a person is needed
        self.assertIsNone(sup.poll())                                           # but it never gives up the container
        self.assertEqual(self.log().count("rolled_back"), 1)                   # rolled back once only

    def ready_line(self) -> str:
        """A child-script line that marks the console ready. child.json names the pid as soon as it is spawned,
        before the child has run any code, so a test that needs the child's SIGTERM disposition in place waits
        for this file (written after the disposition is set), never for child.json alone or for a sleep."""
        return f"pathlib.Path({str(self.tmp / 'ready')!r}).write_text('x')\n"

    def wait_ready(self):
        wait_for(lambda: (self.tmp / "ready").exists())
        return wait_for(lambda: self.child() and self.child()["pid"])

    def test_an_engine_stop_passes_to_the_console_and_ends_the_supervisor(self):
        marker = self.tmp / "got-term"
        sup = self.supervise(self.child_script(
            f"import time, signal, sys, pathlib\n"
            f"signal.signal(signal.SIGTERM, lambda *a: (pathlib.Path({str(marker)!r}).write_text('x'), sys.exit(0)))\n"
            + self.ready_line() +
            f"time.sleep(600)\n"))
        self.wait_ready()
        sup.send_signal(signal.SIGTERM)
        self.assertEqual(sup.wait(timeout=15), 0)
        self.assertTrue(marker.exists())
        self.assertIn("stopped code=0", self.log())

    def test_an_engine_stop_is_clean_even_if_the_console_dies_of_the_sigterm(self):
        # The default SIGTERM disposition: what a console still starting up (no handler yet) does.
        sup = self.supervise(self.child_script("import time, pathlib\n" + self.ready_line() + "time.sleep(600)\n"))
        child = self.wait_ready()
        sup.send_signal(signal.SIGTERM)
        self.assertEqual(sup.wait(timeout=15), 0)
        self.assertFalse(self.alive(child))
        self.assertIn("stopped code=-15", self.log())
        self.assertNotIn("killed_after_grace", self.log())

    STUBBORN = "import time, signal, pathlib\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\n{ready}time.sleep(600)\n"

    def stubborn(self) -> Path:
        return self.child_script(self.STUBBORN.format(ready=self.ready_line()))

    def test_a_console_that_ignores_sigterm_is_killed_after_the_grace_period_on_restart(self):
        sup = self.supervise(self.stubborn())
        before = self.wait_ready()
        started = time.monotonic()
        out = subprocess.run([sys.executable, str(SUPERVISE), "restart", "--state", str(self.state)],
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)                         # not wedged
        self.assertLess(time.monotonic() - started, 10)                          # grace is 2 s in this test
        self.assertFalse(self.alive(before))
        self.assertIn("killed_after_grace", self.log())
        self.assertIsNone(sup.poll())

    def test_an_engine_stop_is_not_wedged_by_a_console_that_ignores_sigterm(self):
        sup = self.supervise(self.stubborn())
        child = self.wait_ready()
        sup.send_signal(signal.SIGTERM)
        self.assertEqual(sup.wait(timeout=15), 128 + signal.SIGKILL)            # returns: ended, but not cleanly
        self.assertFalse(self.alive(child))
        self.assertIn("killed_after_grace", self.log())

    def test_a_stop_during_the_spawn_still_reaches_the_new_console(self):
        # The signal handler can run inside Popen, after the fork but before self.child names the new console;
        # the stop must not be lost there, or wait_child would wait on a console nobody asked to go.
        import importlib.util
        spec = importlib.util.spec_from_file_location("supervise_under_test", SUPERVISE)
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        self.state.mkdir(parents=True)
        sup = mod.Supervisor([sys.executable, "-c", "import time; time.sleep(600)"], self.state, grace=60)
        procs = self.procs

        class StopArrivesMidSpawn(subprocess.Popen):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, **kwargs)
                procs.append(self)
                sup.on_stop()                                                   # self.child is still None here

        with mock.patch.object(mod.subprocess, "Popen", StopArrivesMidSpawn),\
                contextlib.redirect_stderr(io.StringIO()):
            sup.start()
        self.assertIsNotNone(sup.asked_at)
        self.assertEqual(sup.wait_child(), -signal.SIGTERM)                       # well inside the 60 s grace
        self.assertEqual(sup.stop_status(-signal.SIGTERM), 0)

    def test_restart_without_a_supervisor_says_so(self):
        out = subprocess.run([sys.executable, str(SUPERVISE), "restart", "--state", str(self.state)],
                             capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 2)
        self.assertIn("no running supervisor", out.stderr)


    # ---- console environment file --------------------------------------------------------------------
    REPORTS_ENV = ("import os, signal, sys, time, pathlib\n"
                   "out = pathlib.Path(sys.argv[1]) / f'env-{os.getpid()}'\n"
                   "out.write_text(os.environ.get('FLEET_RUNTIME_POLICY', '<unset>'))\n"
                   "signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))\n"
                   "time.sleep(600)\n")

    def env_setup(self):
        self.root = self.tmp / "runtime"; self.root.mkdir()
        self.policy = self.root / "runtime-policy.json"; self.policy.write_text("{}")
        self.seen = self.tmp / "seen"; self.seen.mkdir()
        self.state.mkdir(parents=True, exist_ok=True)
        child = self.child_script(self.REPORTS_ENV)
        return [sys.executable, str(SUPERVISE), "run", "--state", str(self.state), "--fast-seconds", "2",
                "--max-backoff", "0.5", "--grace", "2", "--env-root", str(self.root), "--", sys.executable, str(child),
                str(self.seen)]

    def run_env(self, argv):
        env = {k: v for k, v in os.environ.items() if k != "FLEET_RUNTIME_POLICY"}
        proc = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        self.procs.append(proc)
        return proc

    def seen_by(self, pid):
        return wait_for(lambda: (self.seen / f"env-{pid}").exists() and (self.seen / f"env-{pid}").read_text())

    def test_env_file_reaches_the_console_and_persists_across_restarts(self):
        argv = self.env_setup()
        (self.state / "child.env").write_text(f"# set by the owner\n\nFLEET_RUNTIME_POLICY={self.policy}\n")
        sup = self.run_env(argv)
        first = wait_for(lambda: self.child() and self.child()["pid"])
        self.assertEqual(self.seen_by(first), str(self.policy))
        restart = lambda: subprocess.run([sys.executable, str(SUPERVISE), "restart", "--state", str(self.state)],
                                         capture_output=True, text=True, timeout=30)
        self.assertEqual(restart().returncode, 0)
        second = self.child()["pid"]
        self.assertEqual(self.seen_by(second), str(self.policy))                    # kept by a restart
        (self.state / "child.env").unlink()
        self.assertEqual(restart().returncode, 0)
        self.assertEqual(self.seen_by(self.child()["pid"]), "<unset>")             # read again at every start
        self.assertIn("env_file keys=FLEET_RUNTIME_POLICY", self.log())
        self.assertNotIn(str(self.policy), self.log())                              # values are never logged
        self.assertIsNone(sup.poll())

    def test_a_bad_env_file_is_ignored_whole_and_never_stops_the_console(self):
        argv = self.env_setup()
        (self.state / "child.env").write_text(f"FLEET_RUNTIME_POLICY={self.policy}\nNODE_OPTIONS=--require=/tmp/x.js\n")
        sup = self.run_env(argv)
        pid = wait_for(lambda: self.child() and self.child()["pid"])
        self.assertEqual(self.seen_by(pid), "<unset>")                              # all or nothing
        self.assertIn("alert env_file=ignored reason=line_2:_NODE_OPTIONS_is_not_an_allowed_name", self.log())
        self.assertNotIn("/tmp/x.js", self.log())
        self.assertIsNone(sup.poll())

    def test_without_an_env_root_the_env_file_is_not_read(self):
        argv = self.env_setup()
        cut = argv.index("--env-root"); del argv[cut:cut + 2]
        (self.state / "child.env").write_text(f"FLEET_RUNTIME_POLICY={self.policy}\n")
        sup = self.run_env(argv)
        pid = wait_for(lambda: self.child() and self.child()["pid"])
        self.assertEqual(self.seen_by(pid), "<unset>")
        self.assertNotIn("env_file", self.log())
        self.assertIsNone(sup.poll())

    def test_a_fifo_env_file_never_blocks_a_start(self):
        argv = self.env_setup()
        os.mkfifo(self.state / "child.env")
        sup = self.run_env(argv)
        pid = wait_for(lambda: self.child() and self.child()["pid"], timeout=10)
        self.assertEqual(self.seen_by(pid), "<unset>")
        self.assertIn("not_a_regular_file", self.log())
        self.assertIsNone(sup.poll())


class EnvFileRulesTest(unittest.TestCase):
    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("supervise_under_test", SUPERVISE)
        self.mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.mod)
        self.tmp = Path(tempfile.mkdtemp())
        self.root = self.tmp / "runtime"; self.root.mkdir()
        self.policy = self.root / "runtime-policy.json"; self.policy.write_text("{}")
        self.file = self.tmp / "child.env"

    def read(self, text=None):
        if text is not None: self.file.write_text(text)
        return self.mod.read_env_file(self.file, self.root)

    def refused(self, text, reason):
        with self.assertRaisesRegex(ValueError, reason):
            self.read(text)

    def test_valid_and_missing(self):
        self.assertEqual(self.read(f"FLEET_RUNTIME_POLICY={self.policy}\n"), {"FLEET_RUNTIME_POLICY": str(self.policy)})
        self.assertEqual(self.read("# nothing\n\n"), {})
        self.file.unlink()
        self.assertEqual(self.read(), {})                                            # no file: nothing changes

    def test_names_and_syntax(self):
        self.refused("ANTHROPIC_API_KEY=x\n", "not an allowed name")
        self.refused("fleet_runtime_policy=x\n", "not KEY=VALUE")
        self.refused(f"export FLEET_RUNTIME_POLICY={self.policy}\n", "not KEY=VALUE")
        self.refused(f"FLEET_RUNTIME_POLICY={self.policy}\nFLEET_RUNTIME_POLICY={self.policy}\n", "repeated")
        self.refused(f" FLEET_RUNTIME_POLICY={self.policy}\n", "not KEY=VALUE")

    def test_runtime_policy_values(self):
        outside = self.tmp / "elsewhere.json"; outside.write_text("{}")
        evil = self.tmp / "runtime-evil"; evil.mkdir(); (evil / "p.json").write_text("{}")
        (self.root / "link.json").symlink_to(outside)
        (self.root / "sub").mkdir()
        for value in ["runtime/runtime-policy.json",                                   # relative
                      str(outside),                                                    # outside
                      f"{self.root}/../elsewhere.json",                                # .. out
                      str(self.root / "link.json"),                                    # a link out
                      str(evil / "p.json"),                                            # a sibling with the root as prefix
                      str(self.root),                                                  # the root itself
                      str(self.root / "sub"),                                          # a directory
                      str(self.root / "missing.json"),                                 # missing
                      f"{self.policy} ",                                               # trailing space
                      ""]:
            self.refused(f"FLEET_RUNTIME_POLICY={value}\n", "invalid value")
        before = os.getcwd(); os.chdir(self.tmp)                                       # where it WOULD resolve inside
        try: self.refused("FLEET_RUNTIME_POLICY=runtime/runtime-policy.json\n", "invalid value")
        finally: os.chdir(before)

    def test_the_file_itself(self):
        self.refused("FLEET_RUNTIME_POLICY=" + "x" * 5000 + "\n", "larger than 4096")
        self.file.write_bytes(b"FLEET_RUNTIME_POLICY=\xff\n")
        self.refused(None, "not UTF-8")
        real = self.tmp / "real.env"; real.write_text(f"FLEET_RUNTIME_POLICY={self.policy}\n")
        self.file.unlink(); self.file.symlink_to(real)
        self.refused(None, "unreadable")                                             # never follows a link
        self.file.unlink(); os.mkfifo(self.file)
        self.refused(None, "not a regular file")
        self.file.unlink(); self.file.mkdir()
        self.refused(None, "not a regular file|unreadable")

if __name__ == "__main__":
    unittest.main()
