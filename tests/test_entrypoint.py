"""The image entrypoint prepares an instance on the data volume and survives restarts, upgrades and no network."""
from __future__ import annotations

import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ENTRYPOINT = Path(__file__).resolve().parents[1] / "docker" / "entrypoint.sh"


class EntrypointTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / "instances" / "default"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        # npm fails as if offline; the start must continue without the CLI.
        npm = self.bin / "npm"
        npm.write_text("#!/bin/sh\necho offline >&2\nexit 1\n")
        npm.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def start(self, *command, **env):
        base = {"PATH": f"{self.bin}:/usr/bin:/bin", "HOME": str(self.root), "TMPDIR": str(self.root / "scratch" / "tmp"),
                "REVERIE_DATA": str(self.data)}
        base.update(env)
        return subprocess.run(["bash", str(ENTRYPOINT), *command], env=base, capture_output=True, text=True, timeout=60)

    def test_first_start_creates_instance_and_private_password(self):
        result = self.start("sh", "-c", 'printf "%s|%s|%s|%s" "$CODEMAN_USERNAME" "$REVERIE_DATA_DIR" "$FLEET_DATA_DIR" "${#CODEMAN_PASSWORD}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        user, data_dir, old_data_dir, length = result.stdout.split("|")
        self.assertEqual(user, "owner")
        self.assertEqual(data_dir, str(self.data / "console"))
        self.assertEqual(old_data_dir, data_dir)   # the older spelling is exported too, for one release
        self.assertGreaterEqual(int(length), 20)
        secret = self.data / "owner-password"
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o600)
        self.assertNotIn(secret.read_text().strip(), result.stderr + result.stdout)
        self.assertTrue((self.root / "scratch" / "tmp").is_dir())

    def test_restart_keeps_password_and_state(self):
        self.start("true")
        first = (self.data / "owner-password").read_text()
        (self.data / "console" / "state.json").write_text("{}")
        result = self.start("sh", "-c", 'printf "%s" "$CODEMAN_PASSWORD"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, first.strip())
        self.assertTrue((self.data / "console" / "state.json").exists())
        self.assertEqual(list((self.data / "backups").iterdir()), [])

    def test_given_password_is_used_and_not_stored(self):
        result = self.start("sh", "-c", 'printf "%s" "$CODEMAN_PASSWORD"', CODEMAN_PASSWORD="chosen")
        self.assertEqual(result.stdout, "chosen")
        self.assertFalse((self.data / "owner-password").exists())

    def test_upgrade_backs_up_console_state_once(self):
        self.start("true", REVERIE_VERSION="v0.1.0")
        (self.data / "console" / "state.json").write_text('{"kept": true}')
        self.start("true", REVERIE_VERSION="v0.1.1")
        self.start("true", REVERIE_VERSION="v0.1.1")
        backups = list((self.data / "backups").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertTrue(backups[0].name.startswith("console-v0.1.0-"))
        listing = subprocess.run(["tar", "-tf", str(backups[0])], capture_output=True, text=True).stdout
        self.assertIn("console/state.json", listing)
        self.assertEqual((self.data / ".image-version").read_text().strip(), "v0.1.1")

    def test_offline_cli_install_does_not_fail_the_start(self):
        result = self.start("echo", "started", REVERIE_INSTALL_CLIS="claude-code nonsense")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "started")
        self.assertIn("could not install claude-code", result.stderr)
        self.assertIn("unknown CLI 'nonsense'", result.stderr)

    def test_default_command_is_the_console_on_all_interfaces(self):
        reverie = self.bin / "reverie"
        reverie.write_text('#!/bin/sh\necho "$@"\n')
        reverie.chmod(0o755)
        result = self.start()
        self.assertEqual(result.stdout.strip(), "web --host 0.0.0.0 --port 3000")


if __name__ == "__main__":
    unittest.main()
