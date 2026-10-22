import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from reverie.governance import PolicyError, added_lines, anonymity_violations, check_commit, main

NAMES = ["Alpha", "Bravo", "Sentinel"]   # stand-ins; the owner's real list lives in the instance policy
POLICY = {"agent_anonymity": {"agent_names": NAMES, "allow_paths": ["vendor/*"]}}


class AnonymityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q")
        (self.repo / "old.py").write_text("# kept: Alpha wrote this long ago\nvalue = 1\n")
        self.git("add", "-A"); self.git("commit", "-q", "-m", "base")

    def git(self, *args):
        return subprocess.run(["git", "-c", "user.name=Test Person", "-c", "user.email=test@example.org",
                               "-c", "commit.gpgsign=false", "-C", str(self.repo), *args],
                              check=True, capture_output=True, text=True).stdout

    def stage(self, path, text):
        target = self.repo / path; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(text)
        self.git("add", "-A")
        return self.git("diff", "--cached", "-U0", "--no-color", "--src-prefix=a/", "--dst-prefix=b/")

    def test_message_matches_whole_words_case_sensitively(self):
        found = anonymity_violations(POLICY, "Fix restart\n\nAs Bravo noted, the Sentinel stalls.\n")
        self.assertEqual([(v["where"], v["line"], v["name"]) for v in found],
                         [("message", 3, "Bravo"), ("message", 3, "Sentinel")])
        for clean in ("SentinelTests pass", "the sentinel restarts", "Alphabet soup", "alpha_mode", "BravoX"):
            self.assertEqual(anonymity_violations(POLICY, clean), [], clean)

    def test_only_added_lines_are_scanned(self):
        diff = self.stage("old.py", "# kept: Alpha wrote this long ago\nvalue = 2  # tuned by Bravo\n")
        found = anonymity_violations(POLICY, diff=diff)
        self.assertEqual([(v["where"], v["line"], v["name"]) for v in found], [("old.py", 2, "Bravo")])
        self.git("commit", "-q", "-m", "x")
        diff = self.stage("old.py", "value = 3\n")             # deleting a name is fine
        self.assertEqual(anonymity_violations(POLICY, diff=diff), [])

    def test_allow_paths_and_header_lookalikes(self):
        diff = self.stage("vendor/upstream.js", "// Alpha's upstream comment\n")
        self.assertEqual(anonymity_violations(POLICY, diff=diff), [])
        diff = self.stage("notes.txt", "++ b/vendor/x Alpha\ndiff --git a/vendor/y b/vendor/y\n@@ -1 +1 @@ Bravo\n")
        found = anonymity_violations(POLICY, diff=diff)
        self.assertEqual([(v["where"], v["line"], v["name"]) for v in found], [("notes.txt", 1, "Alpha"), ("notes.txt", 3, "Bravo")])

    def test_added_line_parser_tracks_paths_and_numbers(self):
        diff = self.stage("a.txt", "one\ntwo\n") + self.stage("b.txt", "x\n")
        lines = list(added_lines(self.git("diff", "HEAD", "-U0", "--no-color", "--src-prefix=a/", "--dst-prefix=b/")))
        self.assertEqual(lines, [("a.txt", 1, "one"), ("a.txt", 2, "two"), ("b.txt", 1, "x")])

    def test_check_commit_blocks_names_and_passes_clean_changes(self):
        self.stage("new.py", "def restart():\n    return 'coordinator'\n")
        self.assertTrue(check_commit(self.repo, POLICY, {}, "Restart cleanly\n")["allowed"])
        with self.assertRaisesRegex(PolicyError, "agent_anonymity.*message:1 Alpha"):
            check_commit(self.repo, POLICY, {}, "Alpha: restart cleanly\n")
        self.stage("tests/test_x.py", "SESSION_NAME = 'Sentinel'\n")
        with self.assertRaisesRegex(PolicyError, "tests/test_x.py:1 Sentinel"):
            check_commit(self.repo, POLICY, {}, "Add fixture\n")
        self.assertTrue(check_commit(self.repo, {}, {}, "Alpha\n")["allowed"])   # rule off when absent

    def test_cli_check_anonymity_exit_codes(self):
        policy = self.repo / "policy.json"; policy.write_text(json.dumps(POLICY))
        text = self.repo / "pr.md"; text.write_text("Reviewed by Bravo\n")
        with patch("sys.stdout", new=io.StringIO()) as out:
            self.assertEqual(main(["--policy", str(policy), "check-anonymity", "--text-file", str(text)]), 1)
            self.assertFalse(json.loads(out.getvalue())["allowed"])
        text.write_text("Reviewed by the project\n")
        with patch("sys.stdout", new=io.StringIO()):
            self.assertEqual(main(["--policy", str(policy), "check-anonymity", "--text-file", str(text),
                                   "--staged", str(self.repo)]), 0)


if __name__ == "__main__": unittest.main()
