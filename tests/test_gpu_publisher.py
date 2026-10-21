import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

from cto import gpu_publisher as gp

GOOD = "NVIDIA GeForce RTX 4090, 12, 4096, 24576"


class GpuPublisherTests(unittest.TestCase):
    """The host GPU publisher writes the console's contract, only under the host state dir, never through links."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = gp.state_base(self.root); (self.base / "published").mkdir(parents=True, mode=0o755)
        os.chmod(self.base, 0o700)
        self.file = self.base / "published" / "gpu.json"
        self.out = io.StringIO()

    def smi(self, lines=GOOD, exit_code=0, sleep=0):
        self.fakes = getattr(self, "fakes", 0) + 1
        path = self.root / ("nvidia-smi-%d" % self.fakes)
        body = "#!/bin/sh\n" + ("sleep %d\n" % sleep if sleep else "") + "cat <<'EOF'\n%s\nEOF\nexit %d\n" % (lines, exit_code)
        path.write_text(body); path.chmod(0o755)
        return str(path)

    def publish(self, smi=None, now_ms=1792100000123, **kw):
        return gp.publish_once(self.base, "published/gpu.json", smi or self.smi(), now_ms=now_ms, out=self.out, **kw)

    def files(self):
        return sorted(p.name for p in (self.base / "published").iterdir())

    def test_writes_the_console_contract(self):
        self.assertTrue(self.publish())
        self.assertEqual(json.loads(self.file.read_text()), {
            "updatedAt": 1792100000123,
            "gpus": [{"name": "NVIDIA GeForce RTX 4090", "utilization": 12, "memoryUsedMb": 4096, "memoryTotalMb": 24576}]})
        self.assertEqual(oct(self.file.stat().st_mode & 0o777), "0o644")
        self.assertEqual(self.files(), ["gpu.json"])

    def test_several_gpus_odd_names_and_one_bad_line(self):
        self.publish(smi=self.smi('A100, PCIe 40GB, 90, 1000, 40000\nWeird "name"\\x, 5, 10, 100'))
        self.assertEqual([g["name"] for g in json.loads(self.file.read_text())["gpus"]], ["A100 PCIe 40GB", "Weird name x"])
        before = self.file.read_text()
        self.assertFalse(self.publish(smi=self.smi("A, 5, 10, 100\nB, [N/A], 1, 2"), now_ms=1792100099999))
        self.assertEqual(self.file.read_text(), before)                                   # one bad GPU: nothing written

    def test_bad_output_or_no_gpu_writes_nothing(self):
        for smi in (self.smi(exit_code=9), self.smi("X, 101, 1, 2"), self.smi("X, 5, 9, 8"), self.smi("X, 5, 1, 0"),
                    self.smi(""), self.smi("12, 4096"), str(self.root / "absent"), None):
            with self.subTest(smi=smi):
                self.assertFalse(gp.publish_once(self.base, "published/gpu.json", smi, out=self.out))
                self.assertFalse(self.file.exists())

    def test_a_hung_nvidia_smi_is_abandoned(self):
        started = time.monotonic()
        self.assertFalse(self.publish(smi=self.smi(sleep=30), timeout=1))
        self.assertLess(time.monotonic() - started, 5)

    def test_links_at_the_destination_are_replaced_never_followed(self):
        victim_file = self.root / "victim.txt"; victim_file.write_text("keep")
        victim_dir = self.root / "victimdir"; victim_dir.mkdir()
        for target in (victim_file, victim_dir):
            with self.subTest(target=target.name):
                if self.file.exists() or self.file.is_symlink(): self.file.unlink()
                self.file.symlink_to(target)
                self.assertTrue(self.publish())
                self.assertFalse(self.file.is_symlink())                                   # the link itself was replaced
                self.assertEqual(victim_file.read_text(), "keep")
                self.assertEqual(list(victim_dir.iterdir()), [])                           # nothing dropped into the dir
        self.assertEqual(self.files(), ["gpu.json"])

    def test_a_directory_at_the_destination_fails_and_leaves_no_temp(self):
        self.file.mkdir()
        with self.assertRaises(OSError):
            self.publish()
        self.assertEqual(self.files(), ["gpu.json"])                                       # only the planted dir, no temp
        self.assertTrue(self.file.is_dir())

    def test_symlinked_or_shared_directories_are_refused(self):
        elsewhere = self.root / "agent-writable"; elsewhere.mkdir()
        (self.base / "published").rename(self.base / "real")
        (self.base / "published").symlink_to(elsewhere)                                   # a link in the path
        with self.assertRaises(OSError):
            self.publish()
        self.assertEqual(list(elsewhere.iterdir()), [])
        (self.base / "published").unlink(); (self.base / "real").rename(self.base / "published")
        os.chmod(self.base / "published", 0o777)                                           # group/world writable
        with self.assertRaises(gp.Refused):
            self.publish()
        os.chmod(self.base / "published", 0o755)
        for bad in ("../x/gpu.json", "/abs/gpu.json", "published/../gpu.json", "published//gpu.json", ""):
            with self.subTest(bad=bad), self.assertRaises(gp.Refused):
                gp.write(self.base, bad, b"{}")

    def test_the_base_must_be_the_host_state_dir(self):
        self.assertEqual(gp.state_base("/home/x"), Path("/home/x/.local/state/reverie"))
        os.chmod(self.base, 0o770)
        with self.assertRaises(gp.Refused):
            self.publish()

    def test_temp_files_are_cleaned_and_swept(self):
        with mock.patch("os.rename", side_effect=OSError("boom")), self.assertRaises(OSError):
            self.publish()
        self.assertEqual(self.files(), [])                                                 # the failed temp was removed
        stale = self.base / "published" / ".gpu.json.0123456789abcdef"; stale.write_text("x")
        os.utime(stale, (time.time() - 600, time.time() - 600))
        fresh = self.base / "published" / ".gpu.json.fedcba9876543210"; fresh.write_text("x")
        other = self.base / "published" / "keep.txt"; other.write_text("x")
        gp.sweep(self.base, "published/gpu.json")
        self.assertEqual(self.files(), [".gpu.json.fedcba9876543210", "keep.txt"])

    def test_a_planted_link_at_the_temp_name_is_never_written_through(self):
        victim = self.root / "victim.txt"; victim.write_text("keep"); victim.chmod(0o600)
        (self.base / "published" / ".gpu.json.0000000000000000").symlink_to(victim)
        with mock.patch("secrets.token_hex", return_value="0000000000000000"), self.assertRaises(FileExistsError):
            self.publish()
        self.assertEqual(victim.read_text(), "keep")
        self.assertEqual(victim.stat().st_mode & 0o777, 0o600)                            # not chmodded either
        self.assertFalse(self.file.exists())

    def test_cli_loop_bounds_and_refusal_exit_codes(self):
        with mock.patch.dict(os.environ, {"HOME": str(self.root), "NVIDIA_SMI": self.smi()}),\
                mock.patch("signal.signal"):
            for args in (["--loop", "0"], ["--loop", "31"]):
                with self.assertRaises(SystemExit):
                    gp.main(args, out=self.out)
            self.assertEqual(gp.main([], out=self.out), 0)
            self.assertTrue(self.file.exists())
            os.chmod(self.base / "published", 0o777)
            self.assertEqual(gp.main([], out=self.out), 2)


if __name__ == "__main__": unittest.main()
