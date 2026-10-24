"""Offline focused packaging controls; no Nix build/network/profile mutation."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).parent.parent


class PackagingTests(unittest.TestCase):
    def run_wrapper(self, args, payload=b"", hostile=False):
        recipe = (ROOT / "nix/launch-guard.nix").read_text()
        body = recipe.split("  text = ''\n", 1)[1].rsplit("\n  '';", 1)[0]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "python/reverie"
            target.mkdir(parents=True)
            for name in ("__init__.py", "launch_guard.py"):
                (target / name).write_bytes((ROOT / "python/reverie" / name).read_bytes())
            (root / "share").mkdir()
            (root / "share/example.json").write_bytes((ROOT / "examples/launch-guard-input.json").read_bytes())
            script = root / "wrapper.sh"
            body = body.replace("''${", "${").replace("${payload}", str(root))
            body = body.replace("${pkgs.python3}/bin/python3", sys.executable)
            cat = shutil.which("cat")
            bash = shutil.which("bash")
            self.assertIsNotNone(cat, "The flake test environment must provide coreutils")
            self.assertIsNotNone(bash, "The flake test environment must provide Bash")
            body = body.replace("${pkgs.coreutils}/bin/cat", cat)
            script.write_text("set -euo pipefail\n" + body)
            cwd = root / "hostile"
            cwd.mkdir()
            (cwd / "reverie").mkdir()
            (cwd / "reverie/__init__.py").write_text("raise RuntimeError('ambient module loaded')")
            return subprocess.run([bash, str(script), *args], input=payload,
                                  capture_output=True, timeout=3, cwd=cwd,
                                  env={"PYTHONPATH": str(cwd), "PYTHONHOME": str(cwd)})

    def test_example_and_actual_wrapper_pass_despite_hostile_python_env(self):
        example = self.run_wrapper(["--example"])
        self.assertEqual(example.returncode, 0)
        result = self.run_wrapper([], example.stdout, hostile=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["code"], "GUARD_PASS")
        self.assertEqual(result.stderr, b"")

    def test_wrapper_refusal_preserves_exit_two(self):
        data = json.loads((ROOT / "examples/launch-guard-input.json").read_text())
        data["request"]["currentGoalGeneration"] = 2
        result = self.run_wrapper([], json.dumps(data).encode())
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["code"], "GUARD_GEN_CHANGED")

    def test_help_and_unknown_arguments_never_enter_reducer(self):
        self.assertEqual(self.run_wrapper(["--help"], b"bad").returncode, 0)
        for args in (["--live"], ["--help", "extra"], [""], ["--example", "extra"]):
            self.assertEqual(self.run_wrapper(args).returncode, 2)

    def test_optional_flake_wiring_and_minimal_payload(self):
        flake = (ROOT / "flake.nix").read_text()
        self.assertIn("launchGuard = import ./nix/launch-guard.nix", flake)
        self.assertIn("launch-guard = { type = \"app\"", flake)
        recipe = (ROOT / "nix/launch-guard.nix").read_text()
        self.assertIn(" -I -B -c ", recipe)
        copied = re.findall(r"cp \$\{src\}(/[^ ]+)", recipe)
        self.assertEqual(copied, ["/python/reverie/__init__.py", "/python/reverie/launch_guard.py",
                                 "/examples/launch-guard-input.json", "/schemas/launch-guard-receipt-v1.json"])
        self.assertNotIn("launchGuard", (ROOT / "nix/image.nix").read_text())


if __name__ == "__main__":
    unittest.main()
