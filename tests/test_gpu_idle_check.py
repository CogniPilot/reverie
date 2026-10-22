from tests import executable_script
import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "gpu-idle-check"


class GpuIdleCheckTests(unittest.TestCase):
    """The host ExecCondition fails closed and sees utilisation, foreign GPU processes and the hold file."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def fake_smi(self, util="0", apps="", exit_code=0):
        self.fakes = getattr(self, "fakes", 0) + 1
        path = self.root / ("nvidia-smi-%d" % self.fakes)
        path.write_text(executable_script("#!/bin/sh\n"
                        "case \"$1\" in --query-gpu=*) printf '%s\\n' \"$UTIL\";; *) printf '%s' \"$APPS\";; esac\n"
                        "exit ") + str(exit_code) + "\n")
        path.chmod(0o755)
        return {"NVIDIA_SMI": str(path), "UTIL": util, "APPS": apps}

    def run_check(self, **env):
        base = {"PATH": os.environ["PATH"], "HOME": str(self.root), "GPU_IDLE_SAMPLES": "1"}
        return subprocess.run(["bash", str(SCRIPT)], env={**base, **env}, capture_output=True, text=True).returncode

    def test_idle_gpu_with_only_the_router_passes(self):
        self.assertEqual(self.run_check(**self.fake_smi(util="3", apps="4242, /nix/store/x/bin/llama-server, 18000\n")), 0)
        self.assertEqual(self.run_check(**self.fake_smi(util="0", apps="")), 0)

    def test_busy_or_unknown_states_skip_the_tick(self):
        cases = {
            "high utilisation": self.fake_smi(util="40"),
            "a second GPU busy": self.fake_smi(util="0\n90"),
            "foreign process": self.fake_smi(apps="777, python3, 900\n"),
            "driver error": self.fake_smi(exit_code=9),
            "garbage": self.fake_smi(util="[N/A]"),
            "no GPU": self.fake_smi(util=""),
            "missing nvidia-smi": {"NVIDIA_SMI": str(self.root / "absent")},
        }
        for label, env in cases.items():
            with self.subTest(label):
                self.assertEqual(self.run_check(**env), 1)

    def test_driver_wordings_for_no_or_unnamed_processes(self):
        self.assertEqual(self.run_check(**self.fake_smi(apps="No running processes found\n")), 0)
        unnamed = self.fake_smi(apps="4242, [Not Found], 18000\n")
        result = subprocess.run(["bash", str(SCRIPT)], env={"PATH": os.environ["PATH"], "HOME": str(self.root),
                                "GPU_IDLE_SAMPLES": "1", **unnamed}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("GPU_IDLE_ALLOW_UNNAMED=1", result.stderr)          # says how to allow it, not silent
        self.assertEqual(self.run_check(GPU_IDLE_ALLOW_UNNAMED="1", **unnamed), 0)

    def test_hold_file_blocks(self):
        hold = self.root / "reverie" / "runtime" / "gpu.hold"; hold.parent.mkdir(parents=True); hold.touch()
        self.assertEqual(self.run_check(**self.fake_smi()), 1)
        os.unlink(hold)
        self.assertEqual(self.run_check(**self.fake_smi()), 0)


if __name__ == "__main__":
    unittest.main()
