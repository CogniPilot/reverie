"""Bounded source-filter evaluations; no derivation builds or host operations."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("nix-instantiate"), "Nix evaluator unavailable")
class SourceFilterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        found = subprocess.run(["nix-instantiate", "--find-file", "nixpkgs"],
                               capture_output=True, text=True, timeout=10)
        if found.returncode:
            raise unittest.SkipTest("Nixpkgs library unavailable; run source_filter_eval.nix with flake lib")
        cls.library = Path(found.stdout.strip()) / "lib"

    def evaluate(self, expression):
        result = subprocess.run(["nix-instantiate", "--eval", "--strict", "--json", "--read-write-mode", "--expr", expression],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_policy_cases(self):
        checks = self.evaluate(f"import {ROOT}/tests/source_filter_eval.nix {{ lib = import {self.library}; }}")
        self.assertEqual(len(checks), 25)
        self.assertTrue(all(checks.values()))

    def test_every_tracked_input_is_preserved(self):
        if not shutil.which("git"):
            self.skipTest("Git index unavailable in source archive")
        top = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=ROOT,
                             capture_output=True, text=True, timeout=10)
        if top.returncode or Path(top.stdout.strip()).resolve() != ROOT:
            self.skipTest("Tracked-input audit requires this checkout's own Git index")
        tracked = subprocess.run(["git", "ls-files", "--stage", "-z"], cwd=ROOT,
                                 capture_output=True, check=True, timeout=10).stdout.decode()
        entries = []
        for record in tracked.split("\0"):
            if not record:
                continue
            metadata, path = record.split("\t", 1)
            entries.append({"path": path, "type": "symlink" if metadata.startswith("120000 ") else "regular"})
        self.assertGreater(len(entries), 2000)
        with tempfile.TemporaryDirectory(prefix="reverie-source-audit-") as tmp:
            inventory = Path(tmp) / "tracked.json"
            inventory.write_text(json.dumps(entries))
            dropped = self.evaluate(f'''let lib = import {self.library};
              keep = import {ROOT}/nix/source-filter-policy.nix {{ inherit lib; }};
              entries = builtins.fromJSON (builtins.readFile {inventory});
              in builtins.filter (e: !(keep e.path e.type)) entries''')
            self.assertEqual(dropped, [])

    def test_metadata_and_junk_do_not_change_filtered_snapshot(self):
        with tempfile.TemporaryDirectory(prefix="reverie-source-fixtures-") as tmp:
            a, b = Path(tmp) / "checkout-a", Path(tmp) / "checkout-b"
            for root in (a, b):
                for relative in ("python/reverie/main.py", ".github/ci/check.sh",
                                 "apps/web/src/web/public/gesture/model.task"):
                    path = root / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("source-input\n")
                (root / "skill-link").symlink_to("python/reverie/main.py")
                junk = root / "apps/web/node_modules/pkg/index.js"
                junk.parent.mkdir(parents=True)
                junk.write_text(str(root))
            (a / ".git").mkdir()
            (a / ".git/objects").write_text("metadata-a")
            (b / ".git").write_text("gitdir: /unread/worktree\n")
            expression = f'''let lib = import {self.library};
              clean = src: import {ROOT}/nix/source-filter.nix {{ inherit lib src; }};
              a = clean {a}; b = clean {b};
              in {{ equal = toString a == toString b;
                aPath = toString a; bPath = toString b;
                noGit = !(builtins.pathExists (a + "/.git")) && !(builtins.pathExists (b + "/.git"));
                noJunk = !(builtins.pathExists (a + "/apps/web/node_modules"));
                preserved = builtins.readFile (a + "/.github/ci/check.sh") == "source-input\\n"
                  && builtins.readFile (a + "/skill-link") == "source-input\\n";
              }}'''
            first = self.evaluate(expression)
            self.assertTrue(first["equal"] and first["noGit"] and first["noJunk"] and first["preserved"])
            (b / "python/reverie/main.py").write_text("changed-source\n")
            second = self.evaluate(expression)
            self.assertFalse(second["equal"])
            self.assertEqual(first["aPath"], second["aPath"])

    def test_no_raw_repository_root_references_in_flake(self):
        text = (ROOT / "flake.nix").read_text()
        self.assertNotIn("src = self;", text)
        self.assertNotIn("${self}", text)
        self.assertIn("self.packages.", text)
        self.assertIn("self.nixosModules.", text)

    @unittest.skipUnless(shutil.which("nix") and shutil.which("git"), "Nix/Git capture tools unavailable")
    def test_actual_git_capture_and_export_fallback(self):
        with tempfile.TemporaryDirectory(prefix="reverie-flake-capture-") as tmp:
            repo, exported = Path(tmp) / "git-source", Path(tmp) / "exported source"
            for root in (repo, exported):
                root.mkdir()
                (root / "flake.nix").write_text("{ outputs = { self }: {}; }\n")
                (root / "tracked.txt").write_text("source\n")
            subprocess.run(["git", "init", "-q", str(repo)], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repo), "-c", "user.name=fixture", "-c",
                            "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
                            "commit", "-qm", "fixture"], check=True, capture_output=True)
            (repo / "untracked.txt").write_text("not-selected\n")

            def captured(reference):
                result = subprocess.run(["nix", "--extra-experimental-features", "nix-command flakes",
                                         "flake", "metadata", "--offline", "--no-write-lock-file", "--json", reference],
                                        capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                return Path(json.loads(result.stdout)["path"])

            selected = captured(str(repo))
            self.assertFalse((selected / ".git").exists())
            self.assertFalse((selected / "untracked.txt").exists())
            self.assertEqual((selected / "tracked.txt").read_text(), "source\n")
            raw = captured("path:" + str(repo))
            self.assertTrue((raw / ".git").exists())
            self.assertTrue((raw / "untracked.txt").exists())
            self.assertEqual((captured(str(exported)) / "tracked.txt").read_text(), "source\n")
            (repo / "tracked.txt").write_text("dirty-working-tree\n")
            self.assertEqual((captured(str(repo)) / "tracked.txt").read_text(), "dirty-working-tree\n")
            subprocess.run(["git", "-C", str(repo), "add", "untracked.txt"], check=True, capture_output=True)
            self.assertEqual((captured(str(repo)) / "untracked.txt").read_text(), "not-selected\n")


if __name__ == "__main__":
    unittest.main()
