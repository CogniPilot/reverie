"""scripts/container-memory against a fake launcher: no podman, no host changes."""
import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "container-memory"
GiB = 1 << 30

# Emulates `fleet-container engine ...` for one container whose limit lives in a file.
# The --memory flags below are what --persist must rewrite.
LAUNCHER = r'''#!/usr/bin/env bash
# podman run ... --memory=4g --memory-swap=4g ...
state="$(dirname "$0")/limit"; log="$(dirname "$0")/calls"
[ "$1" = engine ] || exit 2; shift; echo "$*" >> "$log"
case "$1 $2" in
  "container exists") [ "$3" = reverie-live ] ;;
  "ps -a") echo reverie-live ;;
  "stats --no-stream") echo "In use:        1GiB / 4GiB" ;;
  *) case "$*" in
       *HostConfig.Memory*) cat "$state" ;;
       *State.Running*) echo true ;;
       *State.CgroupPath*) echo none ;;
       update*) m="${2#--memory=}"; case "$m" in *g) echo $(( ${m%g} * 1073741824 ));; *m) echo $(( ${m%m} * 1048576 ));; esac > "$state"
                [ -f "$(dirname "$0")/lie" ] && echo 1 > "$state"; true ;;
       *) exit 3 ;;
     esac ;;
esac
'''


class ContainerMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.launcher = self.root / "fleet-container"
        self.launcher.write_text(LAUNCHER); self.launcher.chmod(0o755)
        (self.root / "limit").write_text(str(4 * GiB))
        self.source = self.root / "src-fleet-container"
        self.source.write_text('podman run --memory=4g --memory-swap=4g "$image"\n')

    def run_tool(self, *args):
        env = {"PATH": os.environ["PATH"], "HOME": str(self.root), "FLEET_LAUNCHER": str(self.launcher),
               "FLEET_CONTAINER_SCRIPT": str(self.source)}
        return subprocess.run(["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=30)

    def calls(self):
        return (self.root / "calls").read_text().splitlines()

    def test_shows_limit_without_changing_anything(self):
        result = self.run_tool()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Current limit: 4.0 GiB", result.stdout)
        self.assertIn("In use:", result.stdout)
        self.assertFalse(any(call.startswith("update") for call in self.calls()))

    def test_raises_live_with_swap_equal_to_memory(self):
        result = self.run_tool("16g")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("update --memory=16g --memory-swap=16g reverie-live", self.calls())
        self.assertIn("limit is now 16.0 GiB", result.stdout)
        self.assertEqual(self.launcher.read_text().count("--memory=4g"), 1)   # not persisted

    def test_persist_rewrites_launcher_and_source_with_backups(self):
        result = self.run_tool("12g", "--persist")
        self.assertEqual(result.returncode, 0, result.stderr)
        for path in (self.launcher, self.source):
            self.assertIn("--memory=12g --memory-swap=12g", path.read_text())
            self.assertIn("--memory=4g --memory-swap=4g", Path(str(path) + ".bak").read_text())

    def test_refuses_bad_sizes_options_and_unknown_containers(self):
        for args, message in ((["16"], "must look like"), (["1g"], "under 2 GiB"), (["8g", "--persit"], "unknown option"),
                              (["8g", "--persist", "x"], "too many arguments")):
            result = self.run_tool(*args)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertIn(message, result.stderr)
        env_result = subprocess.run(["bash", str(SCRIPT)], env={"PATH": os.environ["PATH"], "HOME": str(self.root),
                                    "FLEET_LAUNCHER": str(self.launcher), "FLEET_CONTAINER_NAME": "other"},
                                    capture_output=True, text=True)
        self.assertIn("no container named 'other'", env_result.stderr)
        self.assertIn("found: reverie-live", env_result.stderr)
        self.assertEqual((self.root / "limit").read_text().strip(), str(4 * GiB))

    def test_reports_when_podman_does_not_apply_the_limit(self):
        (self.root / "lie").touch()
        result = self.run_tool("8g")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("podman accepted the update but reports", result.stderr)

    def test_flake_strips_the_shebang_writeShellApplication_adds_its_own(self):
        flake = (SCRIPT.parent.parent / "flake.nix").read_text()
        self.assertIn('removePrefix "#!/usr/bin/env bash\\n" (builtins.readFile ./scripts/container-memory)', flake)
        self.assertTrue(SCRIPT.read_text().startswith("#!/usr/bin/env bash\n"))
        self.assertEqual(SCRIPT.read_text().count("#!"), 1)


class AutoSizeTests(unittest.TestCase):
    """New installs size memory from the host: half of MemTotal, whole GiB, clamped to 4..32."""
    CASES = {6: "4g", 12: "6g", 31: "15g", 62.7: "31g", 64: "32g", 128: "32g"}   # host GiB -> limit

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def meminfo(self, gib):
        path = self.root / ("meminfo-%s" % gib)
        path.write_text("MemTotal:       %d kB\nMemAvailable:   1024 kB\n" % int(gib * 1048576))
        return path

    def size_from(self, script, gib, **env):
        full = {"PATH": os.environ["PATH"], "HOME": str(self.root), "FLEET_MEMINFO": str(self.meminfo(gib)), **env}
        if script == "fleet-container":
            command = ["bash", str(SCRIPT.parent / "fleet-container"), "memory-default"]
        else:   # the identical function inside container-memory
            body = SCRIPT.read_text()
            function = body[body.index("fleet_memory_size() {"):body.index("\n}\n", body.index("fleet_memory_size() {")) + 3]
            command = ["bash", "-c", "set -euo pipefail\n" + function + "fleet_memory_size"]
        return subprocess.run(command, env=full, capture_output=True, text=True)

    def test_both_scripts_compute_the_same_clamped_size(self):
        for gib, expected in self.CASES.items():
            for script in ("fleet-container", "container-memory"):
                result = self.size_from(script, gib)
                self.assertEqual((result.returncode, result.stdout.strip()), (0, expected), (script, gib, result.stderr))

    def test_override_and_bad_values(self):
        for script in ("fleet-container", "container-memory"):
            self.assertEqual(self.size_from(script, 62.7, FLEET_MEMORY="16g").stdout.strip(), "16g")
            bad = self.size_from(script, 62.7, FLEET_MEMORY="16GB")
            self.assertNotEqual(bad.returncode, 0); self.assertIn("FLEET_MEMORY must look like", bad.stderr)

    def test_new_container_is_created_with_the_printed_auto_size(self):
        repo = SCRIPT.parent.parent
        fake = self.root / "podman"
        fake.write_text("#!/usr/bin/env bash\n"
                        "args=\"$*\"; echo \"$args\" >> \"$(dirname \"$0\")/podman.log\"\n"
                        "case \"$args\" in *'info --format'*) echo true ;; *'container exists'*) exit 1 ;; esac\n")
        fake.chmod(0o755)
        for env, expected in (({}, "31g"), ({"FLEET_MEMORY": "12g"}, "12g")):
            (self.root / "podman.log").unlink(missing_ok=True)
            result = subprocess.run(["bash", str(repo / "scripts" / "fleet-container"), "up"], capture_output=True, text=True,
                                    env={"PATH": os.environ["PATH"], "HOME": str(self.root), "FLEET_PODMAN": str(fake),
                                         "FLEET_SCRATCH": str(self.root / "scratch"), "XDG_RUNTIME_DIR": str(self.root / "run"),
                                         "FLEET_REPO": str(repo), "FLEET_MEMINFO": str(self.meminfo(62.7)), **env})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("with a %s memory limit" % expected, result.stdout)
            run = [line for line in (self.root / "podman.log").read_text().splitlines() if " run " in " " + line + " "]
            self.assertEqual(len(run), 1)
            self.assertIn("--memory=%s --memory-swap=%s" % (expected, expected), run[0])

    def test_container_memory_auto_applies_the_rule_live(self):
        test = ContainerMemoryTests("test_shows_limit_without_changing_anything"); test.setUp()
        try:
            env = {"PATH": os.environ["PATH"], "HOME": str(test.root), "FLEET_LAUNCHER": str(test.launcher),
                   "FLEET_CONTAINER_SCRIPT": str(test.source), "FLEET_MEMINFO": str(self.meminfo(12))}
            shown = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True)
            self.assertIn("Auto size:     6g", shown.stdout)
            applied = subprocess.run(["bash", str(SCRIPT), "auto"], env=env, capture_output=True, text=True)
            self.assertEqual(applied.returncode, 0, applied.stderr)
            self.assertIn("update --memory=6g --memory-swap=6g reverie-live", test.calls())
        finally:
            test.temp.cleanup()


if __name__ == "__main__": unittest.main()
