from __future__ import annotations
import os
import shutil
from tests import executable_script
"""scripts/setup.sh runs one server from the published image; checked with a fake engine, nothing is started."""

import hashlib
import json
import re
import subprocess
import socket
import threading
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
        podman.write_text(executable_script('#!/bin/sh\ncase "$1" in\n  image) echo "example.test/reverie@sha256:0123";;\n'
                          '  container) exit 1;;\nesac\n'))
        podman.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def run_setup(self, *args, engine=True):
        path = str(self.bin) + os.pathsep + os.environ["PATH"] if engine else str(self.root / "empty-path")
        env = {"PATH": path, "HOME": str(self.root), "XDG_CONFIG_HOME": str(self.root / "cfg")}
        return subprocess.run([shutil.which("bash"), str(SETUP), "--dry-run", *args], env=env, capture_output=True, text=True, timeout=60)

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
        self.assertIn("type=volume,src=second-home,dst=/home/agent", run_line)
        self.assertIn("REVERIE_INSTALL_CLIS=claude", run_line)
        self.assertTrue(run_line.endswith("example.test/reverie@sha256:0123"))
        self.assertNotIn("0.0.0.0", run_line)
        self.assertIn("http://127.0.0.1:3100", result.stdout)

    def test_owner_bootstraps_inside_the_container_from_the_host(self):
        result = self.run_setup("--owner", "--name", "second")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "+ podman exec -e REVERIE_DATA_DIR=/instances/default/console second "
                                                "reverie owner bootstrap --username owner --enforce")

    def test_summary_directs_browser_account_setup(self):
        result = self.run_setup()
        self.assertIn("--owner", result.stdout)
        self.assertIn("create your owner account or sign in", result.stdout)

    def test_help_is_the_header_only(self):
        result = subprocess.run(["bash", str(SETUP), "--help"], capture_output=True, text=True, timeout=60)
        self.assertIn("--owner", result.stdout)
        self.assertIn("--offline", result.stdout)
        self.assertNotIn("set -euo", result.stdout)

    def test_rollback_needs_an_earlier_release(self):
        result = self.run_setup("--rollback")
        self.assertEqual(result.returncode, 1)
        self.assertIn("nothing to roll back to", result.stderr)

    def test_rejects_bad_port_and_name(self):
        self.assertEqual(self.run_setup("--port", "abc").returncode, 2)
        self.assertEqual(self.run_setup("--name", "a b").returncode, 2)
        self.assertEqual(self.run_setup("--bogus").returncode, 2)


class OfflineSetupScriptTest(unittest.TestCase):
    image_id = "sha256:" + "a" * 64

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "engine.jsonl"
        self.archive = self.root / "reverie-image.tar"
        self.archive.write_bytes(b"test archive")
        engine_script = executable_script('''#!/usr/bin/python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["ENGINE_LOG"], "a") as stream:
    stream.write(json.dumps(args) + "\\n")
if args[0] == "info":
    sys.exit(int(os.environ.get("INFO_FAIL", "0")))
if args[0] == "load":
    loaded_ref = os.environ.get("LOADED_REF", "example.test/app:latest")
    print("Loaded image: " + loaded_ref, file=sys.stdout if os.environ.get("LOAD_STDOUT") else sys.stderr)
    sys.exit(int(os.environ.get("LOAD_FAIL", "0")))
if args[:2] == ["image", "inspect"]:
    if os.environ.get("WRONG_TAG") == "1":
        sys.exit(1)
    print(os.environ.get("IMAGE_ID", "sha256:" + "a" * 64))
if args[0] == "pull":
    sys.exit(99)
if args[0] == "container" and os.environ.get("MISSING_CONTAINER"):
    sys.exit(1)
''')
        for name in ("docker", "podman"):
            executable = self.bin / name
            executable.write_text(engine_script)
            executable.chmod(0o755)
        curl = self.bin / "curl"
        curl.write_text(executable_script('#!/bin/sh\nprintf "%s" "${HEALTH_CODE:-401}"\n'))
        curl.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def run_setup(self, *args, values=None, base_tools=True):
        env = {"PATH": str(self.bin) + os.pathsep + os.environ["PATH"] if base_tools else str(self.bin),
               "HOME": str(self.root), "XDG_CONFIG_HOME": str(self.root / "cfg"),
               "ENGINE_LOG": str(self.log), **(values or {})}
        return subprocess.run([shutil.which("bash"), str(SETUP), "--engine", "docker", "--image", "example.test/app", *args],
                              cwd=self.root, env=env, capture_output=True, text=True, timeout=10)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines() if json.loads(line) != ["info"]] if self.log.exists() else []

    def assert_not_replaced(self):
        self.assertFalse(any(call[0] in ("stop", "rm", "run", "pull") for call in self.calls()))
        self.assertFalse((self.root / "reverie" / "runtime" / "setup" / "reverie.versions").exists())

    def test_offline_checks_local_id_before_replacing_and_never_pulls(self):
        result = self.run_setup("--offline", "--image", "example.test/app", "--version", "1.2.3",
                                values={"LOADED_REF": "example.test/app:1.2.3"})
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(calls[0], ["load", "--input", "./reverie-image.tar"])
        self.assertEqual(calls[1], ["image", "inspect", "--format", "{{.Id}}", "example.test/app:1.2.3"])
        self.assertLess(1, next(index for index, call in enumerate(calls) if call[0] == "stop"))
        run_call = next(call for call in calls if call[0] == "run")
        self.assertIn("--pull=never", run_call)
        self.assertEqual(run_call[-1], self.image_id)
        self.assertIn("127.0.0.1:3000:3000", run_call)
        self.assertIn("type=volume,src=reverie-data,dst=/instances", run_call)
        self.assertIn("type=volume,src=reverie-home,dst=/home/agent", run_call)
        self.assertFalse(any(call[0] == "pull" for call in calls))
        self.assertEqual((self.root / "reverie" / "runtime" / "setup" / "reverie.versions").read_text(), self.image_id + "\n")

    def test_offline_accepts_explicit_archive_with_spaces_and_podman(self):
        archive = self.root / "image payload.tar.gz"
        self.archive.rename(archive)
        result = self.run_setup("--engine", "podman", "--offline", str(archive))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls()[0], ["load", "--input", str(archive)])
        run_call = next(call for call in self.calls() if call[0] == "run")
        self.assertIn("--pull=never", run_call)
        self.assertEqual(run_call[run_call.index("--restart") + 1], "always")

    def test_offline_fresh_install_accepts_load_stdout_without_stopping_anything(self):
        result = self.run_setup("--offline", values={"MISSING_CONTAINER": "1", "LOAD_STDOUT": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(call[0] in ("stop", "rm", "pull") for call in self.calls()))
        self.assertIn("--pull=never", next(call for call in self.calls() if call[0] == "run"))

    def test_missing_archive_refuses_without_engine_calls(self):
        self.archive.unlink()
        result = self.run_setup("--offline")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("archive is missing", result.stderr)
        self.assertEqual(self.calls(), [])
        self.assert_not_replaced()

    def test_corrupt_archive_refuses_without_replacement(self):
        result = self.run_setup("--offline", values={"LOAD_FAIL": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.calls()), 1)
        self.assert_not_replaced()

    def test_wrong_tag_refuses_without_replacement(self):
        result = self.run_setup("--offline", values={"WRONG_TAG": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not provide the requested local image", result.stderr)
        self.assert_not_replaced()

    def test_wrong_archive_refuses_even_if_requested_tag_is_already_local(self):
        result = self.run_setup("--offline", values={"LOADED_REF": "example.test/unrelated:latest"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not load the requested image tag", result.stderr)
        self.assertEqual(len(self.calls()), 1)
        self.assert_not_replaced()

    def test_loaded_tag_must_match_the_entire_requested_tag(self):
        for loaded_ref in ("example.test/app:1.2.3", "example.test/app:1.2-extra"):
            with self.subTest(loaded_ref=loaded_ref):
                self.log.unlink(missing_ok=True)
                result = self.run_setup("--offline", "--version", "1.2", values={"LOADED_REF": loaded_ref})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("did not load the requested image tag", result.stderr)
                self.assertEqual(len(self.calls()), 1)
                self.assert_not_replaced()

    def test_invalid_image_id_refuses_without_replacement(self):
        for image_id in ("", "<no value>", "example.test/app:latest"):
            with self.subTest(image_id=image_id):
                result = self.run_setup("--offline", values={"IMAGE_ID": image_id})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("no valid image ID", result.stderr)
                self.assert_not_replaced()

    def test_offline_dry_run_does_not_load_or_replace(self):
        result = self.run_setup("--offline", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("+ docker load --input ./reverie-image.tar", result.stdout)
        self.assertIn("+ docker run --pull=never", result.stdout)
        self.assertTrue(all(call[0] == "container" for call in self.calls()))

    def test_offline_rejects_other_modes(self):
        for mode in ("--owner", "--password", "--rollback"):
            with self.subTest(mode=mode):
                result = self.run_setup("--offline", mode)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(self.calls(), [])

    def test_offline_has_no_host_curl_or_nix_requirement(self):
        (self.bin / "curl").unlink()
        for name in ("mkdir", "tail", "cat", "grep", "id", "seq"):
            (self.bin / name).symlink_to(Path(shutil.which(name)))
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            listener.settimeout(10)
            thread = threading.Thread(target=lambda: listener.accept()[0].close())
            thread.start()
            result = self.run_setup("--offline", "--port", str(listener.getsockname()[1]), base_tools=False)
            thread.join(timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--pull=never", next(call for call in self.calls() if call[0] == "run"))

    def test_unusable_engine_reports_debian_remediation(self):
        result = self.run_setup("--offline", values={"INFO_FAIL": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("usermod -aG docker", result.stderr)
        self.assert_not_replaced()

    def test_unhealthy_container_never_reports_success(self):
        result = self.run_setup("--offline", values={"HEALTH_CODE": "503"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not answer", result.stderr)
        self.assertNotIn("Reverie is running:", result.stdout)
        self.assertIn(["logs", "--tail", "50", "reverie"], self.calls())

    def test_documented_local_install_commands_run_against_the_engine_stub(self):
        guide = SETUP.parent.parent / "docs" / "offline-install.md"
        commands = re.findall(r"```bash\n(.*?)```", guide.read_text(), re.DOTALL)[0]
        (self.root / "setup.sh").write_bytes(SETUP.read_bytes())
        (self.root / "IMAGE-REF.txt").write_text("example.test/app:1.2.3\n")
        checksums = []
        for name in ("setup.sh", "reverie-image.tar", "IMAGE-REF.txt"):
            checksums.append(hashlib.sha256((self.root / name).read_bytes()).hexdigest() + "  " + name)
        (self.root / "SHA256SUMS").write_text("\n".join(checksums) + "\n")
        env = {"PATH": str(self.bin) + os.pathsep + os.environ["PATH"], "HOME": str(self.root),
               "XDG_CONFIG_HOME": str(self.root / "cfg"), "ENGINE_LOG": str(self.log),
               "LOADED_REF": "example.test/app:1.2.3"}
        result = subprocess.run([shutil.which("bash"), "-eu", "-c", commands], cwd=self.root,
                                env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("reverie-image.tar: OK", result.stdout)
        self.assertEqual(self.calls()[1][-1], "example.test/app:1.2.3")
        self.assertIn("--pull=never", next(call for call in self.calls() if call[0] == "run"))


if __name__ == "__main__":
    unittest.main()
