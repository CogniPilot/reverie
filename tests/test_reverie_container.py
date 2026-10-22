from __future__ import annotations
from tests import executable_script
"""Launcher reuse regression: fake engine only, with no real containers or APIs."""
import tests  # noqa: F401  isolates REVERIE_* before reverie is imported

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class ContainerReuseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / "source"
        (self.repo / "docker").mkdir(parents=True)
        (self.repo / "docker/policy.json").write_text('{}')
        self.storage = self.root / "storage"
        self.state = self.root / "console-state"
        self.log = self.root / "engine.jsonl"
        self.engine = self.root / "fake-podman"
        self.engine.write_text(executable_script('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[7:]
with open(os.environ["FAKE_ENGINE_LOG"], "a") as log:
    log.write(json.dumps(args) + "\\n")
if args == ["info", "--format", "{{.Host.Security.Rootless}}"]:
    print("true")
elif args[:2] == ["container", "exists"]:
    sys.exit(0 if os.environ.get("FAKE_EXISTS", "1") == "1" else 1)
elif args[:2] == ["image", "inspect"]:
    print(os.environ.get("FAKE_EXPECTED_IMAGE", "sha256:abc123"))
elif args[0] == "inspect" and args[2] == "{{.Image}}":
    print(os.environ.get("FAKE_ACTUAL_IMAGE", "sha256:abc123"))
elif args[0] == "inspect" and ".Mounts" in args[2]:
    for destination, source in json.loads(os.environ["FAKE_MOUNTS"]):
        print(destination + "\\t" + source)
elif args[0] not in ("start", "run"):
    sys.exit("Unexpected fake engine invocation: " + repr(args))
'''))
        self.engine.chmod(0o700)
        self.mounts = [
            ["/workspace", str(self.repo)],
            ["/scratch", str(self.storage / "workspaces/development")],
            ["/home/agent/.reverie", str(self.state)],
        ]
        self.env = {**os.environ, "HOME": str(self.root / "home"),
                    "REVERIE_REPO": str(self.repo), "REVERIE_SCRATCH": str(self.storage),
                    "REVERIE_WORKSPACE": str(self.storage / "workspaces/development"),
                    "REVERIE_INSTANCE_DATA": str(self.state), "REVERIE_PODMAN": str(self.engine),
                    "REVERIE_CONTAINER_NAME": "owned-test", "REVERIE_IMAGE": "owned-image:test",
                    "FAKE_ENGINE_LOG": str(self.log), "FAKE_MOUNTS": json.dumps(self.mounts)}
        self.script = os.environ.get("REVERIE_CONTAINER_SCRIPT", str(
            Path(__file__).resolve().parents[1] / "scripts/reverie-container"))

    def run_launcher(self):
        return subprocess.run(["bash", self.script, *getattr(self, "scratch_args", []), "up"], env=self.env, capture_output=True, text=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def assert_refused(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fresh REVERIE_CONTAINER_NAME", result.stderr)
        self.assertFalse(any(call[0] in ("start", "run", "stop", "rm") for call in self.calls()))

    def test_matching_image_and_all_three_binds_start_existing_container(self):
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[-1], ["start", "owned-test"])

    def test_changed_image_is_refused_without_stopping_or_recreating(self):
        self.env["FAKE_ACTUAL_IMAGE"] = "sha256:old-image"
        self.assert_refused(self.run_launcher())

    def test_each_changed_bind_is_refused(self):
        for index in range(3):
            with self.subTest(destination=self.mounts[index][0]):
                mounts = [list(mount) for mount in self.mounts]
                mounts[index][1] = str(self.root / "different")
                self.env["FAKE_MOUNTS"] = json.dumps(mounts)
                self.assert_refused(self.run_launcher())

    def test_missing_or_extra_bind_is_refused(self):
        for mounts in (self.mounts[:-1], self.mounts + [["/unexpected-private", str(self.root / "private")]]):
            with self.subTest(mounts=mounts):
                self.env["FAKE_MOUNTS"] = json.dumps(mounts)
                self.assert_refused(self.run_launcher())

    def extra_workspace(self):
        extra = self.root / "second-disk"
        extra.mkdir(exist_ok=True)
        self.scratch_args = ["--scratch-mount", str(extra), "/scratch2"]
        return extra

    def test_optional_second_workspace_is_bound_when_creating(self):
        extra = self.extra_workspace()
        self.env["FAKE_EXISTS"] = "0"
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"type=bind,src={extra.resolve()},dst=/scratch2", self.calls()[-1])

    def test_matching_second_workspace_reuses_existing_container(self):
        extra = self.extra_workspace()
        self.env["FAKE_MOUNTS"] = json.dumps(self.mounts + [["/scratch2", str(extra)]])
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[-1], ["start", "owned-test"])

    def test_changed_missing_or_unrequested_second_workspace_refuses_reuse(self):
        extra = self.extra_workspace()
        for mounts in (self.mounts, self.mounts + [["/scratch2", str(self.root / "other")]]):
            self.env["FAKE_MOUNTS"] = json.dumps(mounts)
            self.assert_refused(self.run_launcher())
        self.scratch_args = []
        self.env["FAKE_MOUNTS"] = json.dumps(self.mounts + [["/scratch2", str(extra)]])
        self.assert_refused(self.run_launcher())

    def test_multiple_extra_drives_and_paths_with_spaces(self):
        extra = self.extra_workspace()
        third = self.root / "third disk"
        third.mkdir()
        self.scratch_args += ["--scratch-mount", str(third), "/scratch3"]
        self.env["FAKE_EXISTS"] = "0"
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"type=bind,src={third.resolve()},dst=/scratch3", self.calls()[-1])
        self.env["FAKE_EXISTS"] = "1"
        self.env["FAKE_MOUNTS"] = json.dumps(self.mounts + [["/scratch2", str(extra)], ["/scratch3", str(third)]])
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_duplicate_or_protected_mount_destinations_are_rejected(self):
        extra = self.extra_workspace()
        for destination in ("/scratch2", "/workspace", "/scratch", "/home/agent", "/scratch2/child"):
            self.scratch_args = ["--scratch-mount", str(extra), "/scratch2", "--scratch-mount", str(extra), destination]
            self.assertNotEqual(self.run_launcher().returncode, 0)
        self.assertFalse(self.log.exists())

    def test_nonexistent_extra_directory_is_rejected_before_engine_access(self):
        self.scratch_args = ["--scratch-mount", str(self.root / "absent-disk"), "/scratch2"]
        result = self.run_launcher()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("existing directory", result.stderr)
        self.assertFalse(self.log.exists())

    def test_symlink_aliases_compare_as_the_same_actual_paths(self):
        self.storage.mkdir()
        self.state.mkdir()
        for key, target in (("REVERIE_REPO", self.repo), ("REVERIE_SCRATCH", self.storage),
                            ("REVERIE_INSTANCE_DATA", self.state)):
            alias = self.root / ("alias-" + key)
            alias.symlink_to(target, target_is_directory=True)
            self.env[key] = str(alias)
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[-1], ["start", "owned-test"])

    def test_new_container_retains_init_and_canonical_binds(self):
        self.env["FAKE_EXISTS"] = "0"
        result = self.run_launcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        run = self.calls()[-1]
        self.assertEqual(run[0], "run")
        self.assertIn("--init", run)
        for destination, source in self.mounts:
            self.assertIn(f"type=bind,src={Path(source).resolve()},dst={destination}", run)
        self.assertFalse(any(call[0] in ("start", "stop", "rm") for call in self.calls()))


if __name__ == "__main__":
    unittest.main()
