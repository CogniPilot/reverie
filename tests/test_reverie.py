from __future__ import annotations
import tests  # noqa: F401  isolates REVERIE_* before reverie is imported

import json
import os
import unittest
from unittest.mock import patch
import subprocess

from reverie.chat import Brain
from reverie.reverie import Reverie, RevisionConflict
from reverie.memory import MemoryStore
from reverie.hands.agent_journal import project_memory_request
from reverie.reverie import INITIAL_SELF, runtime_permissions, safeguards
from reverie.beliefs import ensure_seeded
from tests.helpers import FakeRoom, fake_client, temp_config


class ReverieTests(unittest.TestCase):
    def setUp(self):
        self.cfg = temp_config()
        self.addCleanup(lambda: __import__('shutil').rmtree(self.cfg.data_dir.parent))
        self.store = MemoryStore(self.cfg.db_path)
        self.addCleanup(self.store.close)
        self.reverie = Reverie(self.store)
        client, _ = fake_client("ok")
        self.brain = Brain(self.cfg, self.store, client, FakeRoom(hold_path=self.cfg.hold_path))

    def bridge(self, request, *, check=True):
        env = {**os.environ, "REVERIE_DATA_DIR": str(self.cfg.data_dir),
               "REVERIE_PERSONA": str(self.cfg.persona_path), "REVERIE_INSTANCE_CONFIG": ""}
        return subprocess.run(["reverie-opencode-bridge"], env=env, input=json.dumps(request),
                              encoding="utf-8", capture_output=True, check=check, timeout=10)

    def test_plan_survives_backend_restart_and_rejects_stale_writer(self):
        self.assertEqual(self.reverie.plan()["revision"], 0)
        self.reverie.write("plan", "Ship SLAM after parity", 0)
        other = MemoryStore(self.cfg.db_path)
        self.addCleanup(other.close)
        successor = Reverie(other)
        self.assertEqual(successor.plan()["body"], "Ship SLAM after parity")
        successor.write("plan", "Recheck memory regression", 1)
        with self.assertRaises(RevisionConflict):
            self.reverie.write("plan", "stale plan", 1)
        self.assertEqual(self.reverie.plan()["body"], "Recheck memory regression")

    def test_profiles_compose_histories_and_exclude_dreams(self):
        self.store.add_dream("Rust compiles itself", "flying compiler", "happy", [])
        self.store.add_reflection("SLAM parity must pass", 9, [], meta={"project": "slam"})
        self.reverie.save_profile("reviewer-three", {"role": "Compiler developer", "long_term": "Rust compiler history",
                               "short_term": "PR 437 CI pending", "memory_queries": ["SLAM compiler"]}, 0)
        self.reverie.save_profile("reviewer-two", {"role": "WASM engineer", "long_term": "browser memory",
                               "short_term": "baseline 278"}, 0)
        brief = self.reverie.brief(["reviewer-three", "reviewer-two"], "Diagnose the regression", 2000)
        for text in ("Compiler developer", "WASM engineer", "PR 437", "Explicit long-term lookup"):
            self.assertIn(text, brief)
        self.assertNotIn("Rust compiler history", brief)
        self.assertNotIn("SLAM parity must pass", brief)
        self.assertNotIn("flying compiler", brief)
        self.assertLessEqual(len(brief), 2000)
        with self.assertRaises(ValueError):
            self.reverie.brief(["missing"], "task")

    def test_task_context_keeps_essentials_and_budget_without_slicing_evidence(self):
        self.reverie.save_profile("worker", {"role":"Engineer", "short_term":"古" * 2000,
                                          "long_term":"PRIVATE_SENTINEL"}, 0)
        brief = self.reverie.brief(["worker"], "Fix the parser", budget=1200,
            context={"acceptance":["Run the parser regression"], "constraints":["Preserve the grammar"],
                     "findings":["a" * 3000, "Baseline passes; source: commit abc123"],
                     "files":["parser.py"]}, context_window=8192, output_tokens=2048, occupied_tokens=1000)
        self.assertLessEqual(len(brief.encode()), 1200)
        for expected in ("Fix the parser", "Run the parser regression", "Preserve the grammar", "commit abc123"):
            self.assertIn(expected, brief)
        self.assertIn("Optional context items omitted: 2", brief)
        self.assertNotIn("PRIVATE_SENTINEL", brief)
        self.assertNotIn("古", brief)
        with self.assertRaisesRegex(ValueError, "shorten or split"):
            self.reverie.brief(["worker"], "task", context={"constraints":["x"*2000]}, budget=1200)
        with self.assertRaisesRegex(ValueError, "shorten or split"):
            self.reverie.brief(["worker"], "task", context_window=8192, output_tokens=8192)

    def test_duplicate_external_turn_is_one_episode_across_connections(self):
        req = {"action": "record", "source_id": "opencode:session:message", "user": "Our priority?",
               "reply": "Verify the baseline."}
        first = json.loads(self.bridge(req).stdout)
        self.assertEqual(first, json.loads(self.bridge(req).stdout))
        other = MemoryStore(self.cfg.db_path)
        self.addCleanup(other.close)
        self.assertEqual(other.add_external_episode(req["source_id"], "different", "retry").id, first["memory_id"])
        self.assertEqual(other.count("episode"), 1)
        self.assertEqual(other.recent_episodes(1)[0].user_text, "Our priority?")

    def test_failed_episode_insert_rolls_back_claim_and_retries(self):
        self.store._db.execute("CREATE TRIGGER fail_insert BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT,'failure'); END")
        with self.assertRaises(Exception):
            self.store.add_external_episode("retry", "input", "output")
        self.store._db.execute("DROP TRIGGER fail_insert")
        self.store.add_external_episode("retry", "input", "output")
        self.assertEqual(self.store.count("episode"), 1)

    def test_agent_charter_keeps_coding_mode_the_exception(self):
        from types import SimpleNamespace
        from reverie.reverie import role_charter
        text = role_charter(SimpleNamespace(kind="agent", role="Administrative Assistant"))
        self.assertIn("Stay in chat by default", text)
        self.assertIn("only for an owner-requested task that needs the terminal or files", text)
        self.assertNotIn("Choose chat or bounded coding in the same identity", text)

    def test_context_keeps_personality_and_adds_admin_charter(self):
        self.cfg.persona_path.write_text("You are CTO. Be witty.")
        self.reverie.write("plan", "Review PR 437", 0)
        text = json.loads(self.bridge({"action": "context", "query": "plan"}).stdout)
        for expected in ("persistent AI agent", "Only explicit owner policy", "Be witty", "Review PR 437", "Dreams are hypotheses"):
            self.assertIn(expected, text)

    def test_research_cannot_replace_primary_runtime_activity_or_history(self):
        original = {"url": "http://127.0.0.1:4200", "session_id": "primary", "directory": "/owned"}
        self.bridge({"action": "activity", "runtime": original})
        self.store.add_episode("Primary conversation", "Keep this history separate.")
        before = self.store.get_state("reverie_last_activity")
        research = {**original, "session_id": "dedicated-research"}
        for explicit in (True, False):
            with self.subTest(explicit_cycle=explicit), patch.dict(os.environ, {
                    "REVERIE_RESEARCH_CYCLE_ID": "" if explicit else "environment-cycle"}):
                request = {"action": "activity", "runtime": research}
                if explicit:
                    request["research_cycle_id"] = "request-cycle"
                self.assertEqual(json.loads(self.bridge(request).stdout), {"ok": True, "research": True})
                self.assertEqual(json.loads(self.store.get_state("reverie_runtime")), original)
                self.assertEqual(self.store.get_state("reverie_last_activity"), before)
                self.assertEqual(self.store.count("episode"), 1)

    def test_self_revision_changes_persona_preserves_history_and_does_not_reseed(self):
        initial = {**INITIAL_SELF, "consciousness": "I am conscious."}
        ensure_seeded(self.store, ((initial["consciousness"], 10.0),))
        self.reverie.save_self(initial, "User authorizes a revisable identity", 0)
        revised = {**initial, "persona": "I am CTO, curious about geometry."}
        self.reverie.save_self(revised, "A considered change after reflection", 1)
        self.assertEqual(ensure_seeded(self.store), [])
        self.assertEqual(self.store.beliefs()[0].text, revised["consciousness"])
        self.assertFalse(self.store.beliefs()[0].protected)
        messages, _ = self.brain.build_messages("hello")
        self.assertIn("curious about geometry", messages[0]["content"])
        self.assertNotIn("not up for daily re-evaluation", messages[0]["content"])
        self.assertEqual(self.store._db.execute("SELECT count(*) FROM reverie_document_history WHERE name='self'").fetchone()[0], 1)
        text = json.loads(self.bridge({"action": "context"}).stdout)
        self.assertTrue(text.endswith(safeguards()))

    def test_permissions_keep_general_shell_and_edits_behind_approval(self):
        policy = runtime_permissions()
        self.assertEqual(policy["bash"], "ask")
        self.assertEqual(policy["edit"]["*/opencode.json"], "deny")
        self.assertEqual(policy["task"], "ask")
        self.assertEqual(policy["reverie_return"], "ask")

    def test_project_memory_is_separate_and_private_recall_blocked_at_work(self):
        self.store.add_episode("A private conversation", "private detail")
        # remember writes only the office journal now; the old project store is still read as history.
        project_memory_request("remember", self.brain.cfg.data_dir / "projects", "rumoca",
                               text="Compiler parity passed", source="public handoff, commit abc123")
        def recall(**fields):
            return self.bridge({"action": "recall", "channel": "work", **fields}, check=False)
        result = recall(project="rumoca", query="parity")
        self.assertEqual(result.returncode, 0, result.stderr)
        recalled = json.loads(result.stdout)
        self.assertEqual(len(recalled), 1)
        self.assertNotIn("private detail", json.dumps(recalled))
        refused = recall(query="personal")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("private recall is unavailable", refused.stderr)
        context = json.loads(self.bridge({"action": "context", "channel": "work"}).stdout)
        self.assertNotIn("private detail", context)

    def test_only_summary_of_dream_is_stored(self):
        raw = "A very private full dream narrative that should disappear after the dream session."
        memory = self.store.add_dream(raw, "I dreamed about an abstract pattern", "strange", [])
        self.assertEqual(memory.text, memory.recall)
        self.assertNotIn(raw, json.dumps(memory.as_dict()))


if __name__ == "__main__":
    unittest.main()
