from __future__ import annotations
from tests import executable_script
"""The image entrypoint prepares an instance on the data volume and survives restarts, upgrades and no network."""

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
        # Provider installation runs separately; a failure must not stop the console.
        installer = self.bin / "reverie-install-clis"
        installer.write_text(executable_script("#!/bin/sh\necho 'synthetic provider installation unavailable' >&2\nexit 1\n"))
        installer.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def start(self, *command, **env):
        base = {"PATH": str(self.bin) + os.pathsep + os.environ["PATH"], "HOME": str(self.root), "TMPDIR": str(self.root / "scratch" / "tmp"),
                "REVERIE_DATA": str(self.data)}
        base.update(env)
        return subprocess.run(["bash", str(ENTRYPOINT), *command], env=base, capture_output=True, text=True, timeout=60)

    def test_first_start_creates_instance_and_private_password(self):
        result = self.start("sh", "-c", 'printf "%s|%s|%s" "$REVERIE_USERNAME" "$REVERIE_DATA_DIR" "${#REVERIE_PASSWORD}"')
        self.assertEqual(result.returncode, 0, result.stderr)
        user, data_dir, length = result.stdout.split("|")
        self.assertEqual(user, "owner")
        self.assertEqual(data_dir, str(self.data / "console"))
        self.assertGreaterEqual(int(length), 20)
        secret = self.data / "owner-password"
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode), 0o600)
        self.assertNotIn(secret.read_text().strip(), result.stderr + result.stdout)
        self.assertTrue((self.root / "scratch" / "tmp").is_dir())

    def test_restart_keeps_password_and_state(self):
        self.start("true")
        first = (self.data / "owner-password").read_text()
        (self.data / "console" / "state.json").write_text("{}")
        result = self.start("sh", "-c", 'printf "%s" "$REVERIE_PASSWORD"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, first.strip())
        self.assertTrue((self.data / "console" / "state.json").exists())
        self.assertEqual(list((self.data / "backups").iterdir()), [])

    def test_given_password_is_used_and_not_stored(self):
        result = self.start("sh", "-c", 'printf "%s" "$REVERIE_PASSWORD"', REVERIE_PASSWORD="chosen")
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

    def test_fresh_volume_enables_guarded_browser_setup_without_claiming_owner(self):
        result = self.start("sh", "-c", 'printf "%s" "$REVERIE_OWNER_SETUP"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "1")
        self.assertFalse((self.data / "console" / "owner-auth.policy").exists())
        self.assertFalse((self.data / "console" / "owner-auth.json").exists())
        self.assertNotIn("setup.sh --owner", result.stderr)
        self.assertTrue((self.data / "owner-password").exists())

    def test_existing_policy_or_account_is_kept(self):
        console = self.data / "console"
        console.mkdir(parents=True)
        (console / "owner-auth.policy").write_text("log\n")
        self.start("true")
        self.assertEqual((console / "owner-auth.policy").read_text(), "log\n")
        (console / "owner-auth.policy").unlink()
        (console / "owner-auth.json").write_text("{}")
        self.start("true")
        self.assertFalse((console / "owner-auth.policy").exists())   # the console keeps the account's policy

    def test_upgrade_backup_holds_the_state_before_the_marker(self):
        self.start("true", REVERIE_VERSION="v0.1.0")
        # An unclaimed volume has never recorded a policy marker.
        self.start("true", REVERIE_VERSION="v0.1.1")
        backup = next((self.data / "backups").iterdir())
        listing = subprocess.run(["tar", "-tf", str(backup)], capture_output=True, text=True).stdout
        self.assertNotIn("owner-auth.policy", listing)
        self.assertFalse((self.data / "console" / "owner-auth.policy").exists())

    def test_existing_marker_symlink_is_not_replaced_or_followed(self):
        console = self.data / "console"; console.mkdir(parents=True)
        target = self.root / "missing-owner-policy"
        marker = console / "owner-auth.policy"; marker.symlink_to(target)
        result = self.start("true")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(marker.is_symlink())
        self.assertFalse(target.exists())

    def test_provider_install_failure_does_not_fail_the_start(self):
        result = self.start("echo", "started", REVERIE_INSTALL_CLIS="claude")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "started")
        self.assertIn("provider installation unavailable", result.stderr)

    def test_default_profiles_sign_in_on_the_volume(self):
        result = self.start("sh", "-c", 'printf "%s|%s" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, f"{self.data / 'accounts' / 'claude'}|{self.data / 'accounts' / 'codex'}")
        for name in ("claude", "codex"):
            self.assertEqual(stat.S_IMODE((self.data / "accounts" / name).stat().st_mode), 0o700)

    def test_given_profile_dirs_are_kept(self):
        result = self.start("sh", "-c", 'printf "%s|%s" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"',
                            CLAUDE_CONFIG_DIR="/elsewhere/claude", CODEX_HOME="/elsewhere/codex")
        self.assertEqual(result.stdout, "/elsewhere/claude|/elsewhere/codex")

    def test_default_command_is_the_console_on_all_interfaces(self):
        reverie = self.bin / "reverie"
        reverie.write_text(executable_script('#!/bin/sh\necho "$@"\n'))
        reverie.chmod(0o755)
        result = self.start()
        self.assertEqual(result.stdout.strip(), "web --host 0.0.0.0 --port 3000")


if __name__ == "__main__":
    unittest.main()
