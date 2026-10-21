"""scripts/setup.sh runs one server from the published image; checked with a fake engine, nothing is started."""
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

SETUP = Path(__file__).resolve().parents[1] / "scripts" / "setup.sh"


class SetupScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        podman = self.bin / "podman"
        podman.write_text('#!/bin/sh\ncase "$1" in\n  image) echo "example.test/reverie@sha256:0123";;\n'
                          '  container) exit 1;;\nesac\n')
        podman.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def run_setup(self, *args, engine=True):
        path = f"{self.bin}:/usr/bin:/bin" if engine else "/usr/bin:/bin"
        env = {"PATH": path, "HOME": str(self.root), "XDG_CONFIG_HOME": str(self.root / "cfg")}
        return subprocess.run(["bash", str(SETUP), "--dry-run", *args], env=env, capture_output=True, text=True, timeout=60)

    def test_missing_engine_explains_and_stops(self):
        result = self.run_setup(engine=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("needs Docker or Podman", result.stderr)

    def test_install_binds_loopback_keeps_volume_and_pins_digest(self):
        result = self.run_setup("--version", "v0.1.0", "--port", "3100", "--name", "second", "--with-claude-code")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("+ podman pull ghcr.io/jgoppert/reverie:0.1.0", result.stdout)
        run_line = next(line for line in result.stdout.splitlines() if line.startswith("+ podman run"))
        self.assertIn("--publish 127.0.0.1:3100:3000", run_line)
        self.assertIn("type=volume,src=second-data,dst=/instances", run_line)
        self.assertIn("REVERIE_INSTALL_CLIS=claude-code", run_line)
        self.assertTrue(run_line.endswith("example.test/reverie@sha256:0123"))
        self.assertNotIn("0.0.0.0", run_line)
        self.assertIn("http://127.0.0.1:3100", result.stdout)

    def test_rollback_needs_an_earlier_release(self):
        result = self.run_setup("--rollback")
        self.assertEqual(result.returncode, 1)
        self.assertIn("nothing to roll back to", result.stderr)

    def test_rejects_bad_port_and_name(self):
        self.assertEqual(self.run_setup("--port", "abc").returncode, 2)
        self.assertEqual(self.run_setup("--name", "a b").returncode, 2)
        self.assertEqual(self.run_setup("--bogus").returncode, 2)


if __name__ == "__main__":
    unittest.main()
