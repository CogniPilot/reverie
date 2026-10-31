from __future__ import annotations
import tests  # noqa: F401  isolates REVERIE_* before reverie is imported

import io
import json
import os
from pathlib import Path
import shlex
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from reverie import journal_shim, memory_cli
from reverie.chat import Brain
from reverie.memory import MemoryStore
from reverie.opencode import dispatch
from tests.helpers import FakeRoom, fake_client, temp_config


class Recorder:
    """Stands in for `reverie agent journal ... --json`: records each argument list and replies with one JSON body."""

    def __init__(self, body: dict, code: int = 0, stderr: str = ""):
        self.calls: list[list[str]] = []
        self.body, self.code, self.stderr = body, code, stderr

    def __call__(self, args: list[str]) -> subprocess.CompletedProcess:
        self.calls.append(args)
        return subprocess.CompletedProcess(args, self.code, json.dumps(self.body), self.stderr)


class JournalShimTests(unittest.TestCase):
    def test_available_needs_a_session_of_its_own_and_the_cli(self):
        with tempfile.TemporaryDirectory() as bin_dir:
            cli = Path(bin_dir) / "reverie"
            cli.write_text("#!/bin/sh\nexit 0\n")
            cli.chmod(cli.stat().st_mode | stat.S_IXUSR)
            self.assertFalse(journal_shim.available({"PATH": bin_dir}))
            self.assertFalse(journal_shim.available({"REVERIE_SESSION_ID": "s-1", "PATH": "/nonexistent"}))
            self.assertTrue(journal_shim.available({"REVERIE_SESSION_ID": "s-1", "PATH": bin_dir}))

    def test_remember_without_the_callers_room_and_turn_refuses_and_only_prints_the_command(self):
        runner = Recorder({"success": True, "data": {}})
        for request in ({"text": "Ship on Friday"}, {"text": "Ship on Friday", "room": "r-1", "tag": "decision", "quote": "Friday"},
                        {"text": "Ship on Friday", "turn": "m-1", "tag": "decision", "quote": "Friday"}):
            with self.assertRaises(ValueError) as refused:
                journal_shim.remember(request, runner)
            message = str(refused.exception)
            self.assertIn("Nothing was saved", message)
            command = shlex.split(message.split("run: ", 1)[1])
            self.assertEqual(command[:4], ["reverie", "agent", "journal", "save"])
            self.assertIn("--source", command)  # a usable command, not a quote without its message
        self.assertEqual(runner.calls, [])  # never run, and no room or turn was guessed

    def test_remember_needs_a_journal_tag_and_some_source(self):
        runner = Recorder({"success": True, "data": {}})
        base = {"text": "Ship on Friday", "room": "r-1", "turn": "m-1"}
        for request in ({**base, "quote": "Friday"}, {**base, "tag": "fact", "quote": "Friday"}, {**base, "tag": "decision"}):
            with self.assertRaises(ValueError):
                journal_shim.remember(request, runner)
        self.assertEqual(runner.calls, [])

    def test_remember_saves_under_the_callers_turn_with_a_checked_quote_and_an_unverified_ref(self):
        runner = Recorder({"success": True, "data": {"status": "committed", "entryId": 7}})
        result = journal_shim.remember({"text": "  Compiler parity passed ", "room": "r-1", "turn": "m-9", "tag": "lesson",
                                        "quote": "parity passed", "source": "commit abc123", "project": "rumoca",
                                        "reason": "handoff"}, runner)
        self.assertEqual(result, {"status": "committed", "entryId": 7})
        self.assertEqual(runner.calls, [["reverie", "agent", "journal", "save", "--room", "r-1", "--turn", "m-9",
                                         "--text", "Compiler parity passed", "--tag", "lesson",
                                         "--source", "m-9", "--quote", "parity passed", "--ref", "commit abc123",
                                         "--reason", "handoff", "--project", "rumoca", "--json"]])

    def test_journal_refusals_and_bad_output_are_errors_not_results(self):
        request = {"text": "x", "room": "r-1", "turn": "m-1", "tag": "lesson", "source": "commit 1"}
        with self.assertRaisesRegex(RuntimeError, "turn message is read-only"):
            journal_shim.remember(request, Recorder({"success": False, "error": "turn message is read-only; no journal write"}, 1))
        with self.assertRaisesRegex(RuntimeError, "journal unavailable"):
            journal_shim.recall("x", runner=lambda args: subprocess.CompletedProcess(args, 1, "not json", ""))

    def test_recall_passes_the_query_and_project_as_arguments(self):
        runner = Recorder({"success": True, "data": {"entries": [{"entryId": 3}]}})
        self.assertEqual(journal_shim.recall("compiler; $(rm -rf /)", "rumoca", runner), [{"entryId": 3}])
        self.assertEqual(runner.calls, [["reverie", "agent", "journal", "recall", "compiler; $(rm -rf /)", "--project", "rumoca", "--json"]])
        with self.assertRaises(ValueError):
            journal_shim.recall("  ", runner=runner)


class ScreenTests(unittest.TestCase):
    """The bridge's screen action applies the hard floors to text bound for the journal and writes nothing."""

    def screen(self, text, env=None):
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, env or {}), \
                patch("sys.stdin", io.StringIO(json.dumps({"action": "screen", "text": text}))), patch("sys.stdout", out):
            code = memory_cli.main(["--instance", str(Path(root) / "missing.json")])
            self.assertEqual(list(Path(root).iterdir()), [])  # no store, no instance read
        return code, out.getvalue()

    def test_screen_reports_the_floor_crossed_without_opening_any_store(self):
        self.assertEqual(self.screen("Compiler parity passed"), (0, '{"floor": ""}\n'))
        code, out = self.screen("the forbidden plan", {"REVERIE_OUTPUT_POLICY": json.dumps({"denied_patterns": ["forbidden"]})})
        self.assertEqual((code, json.loads(out)), (0, {"floor": "configured output policy"}))
        with patch("sys.stderr", io.StringIO()):
            self.assertEqual(self.screen("   ")[0], 1)


class DispatchThroughJournalTests(unittest.TestCase):
    def setUp(self):
        self.cfg = temp_config()
        self.addCleanup(lambda: __import__('shutil').rmtree(self.cfg.data_dir.parent))
        self.store = MemoryStore(self.cfg.db_path)
        self.addCleanup(self.store.close)
        client, _ = fake_client("ok")
        self.brain = Brain(self.cfg, self.store, client, FakeRoom(hold_path=self.cfg.hold_path))

    def test_with_the_journal_recall_returns_journal_entries_and_labelled_legacy_history(self):
        self.store.add_reflection("Old note about parity", 7, [], "shared")
        with patch.object(journal_shim, "available", return_value=True), \
                patch.object(journal_shim, "recall", return_value=[{"entryId": 1}]) as recall:
            result = dispatch(self.brain, {"action": "recall", "query": "parity"})
        recall.assert_called_once_with("parity", None)
        self.assertEqual(result["journal"], [{"entryId": 1}])
        self.assertIn("Old note about parity", json.dumps(result["legacy"]))
        self.assertIn("read-only", result["note"])
        # The shared-room rule still applies before anything is read.
        with patch.object(journal_shim, "available", return_value=True), patch.object(journal_shim, "recall") as recall:
            with self.assertRaises(ValueError):
                dispatch(self.brain, {"action": "recall", "query": "personal", "channel": "work"})
        recall.assert_not_called()

    def test_a_failed_journal_lookup_still_answers_from_the_old_store_and_says_so(self):
        self.store.add_reflection("Old note about parity", 7, [], "shared")
        with patch.object(journal_shim, "available", return_value=True), \
                patch.object(journal_shim, "recall", side_effect=RuntimeError("journal unavailable")):
            result = dispatch(self.brain, {"action": "recall", "query": "parity"})
        self.assertEqual(result["journal"], [])
        self.assertIn("Old note about parity", json.dumps(result["legacy"]))
        self.assertIn("journal lookup failed (journal unavailable)", result["note"])

    def test_with_the_journal_remember_goes_to_the_journal_only(self):
        before = self.store._db.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        with patch.object(journal_shim, "available", return_value=True), \
                patch.object(journal_shim, "remember", return_value={"entryId": 2}) as remember:
            self.assertEqual(dispatch(self.brain, {"action": "remember", "text": " Ship on Friday ", "room": "r-1", "turn": "m-1",
                                                   "tag": "decision", "quote": "Friday"}), {"entryId": 2})
        self.assertEqual(remember.call_args.args[0]["text"], "Ship on Friday")
        self.assertEqual(self.store._db.execute("SELECT COUNT(*) FROM memories").fetchone()[0], before)
        # The hard floors still apply first.
        with patch.object(journal_shim, "available", return_value=True), patch.object(journal_shim, "remember") as remember:
            with self.assertRaises(ValueError):
                dispatch(self.brain, {"action": "remember", "text": "   "})
        remember.assert_not_called()

    def test_without_the_journal_the_old_store_behaves_as_before(self):
        self.assertFalse(journal_shim.available())
        saved = dispatch(self.brain, {"action": "remember", "text": "A verified note"})
        self.assertEqual(saved["text"], "A verified note")
        self.assertIn("not to your office journal", saved["note"])  # never mistaken for a journal save
        project = dispatch(self.brain, {"action": "remember", "text": "Parity passed", "project": "rumoca", "source": "commit 1"})
        self.assertEqual(project["note"], journal_shim.LOCAL_ONLY)
        self.assertIsInstance(dispatch(self.brain, {"action": "recall", "query": "verified note"}), list)


if __name__ == "__main__":
    unittest.main()
