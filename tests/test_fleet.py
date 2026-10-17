from __future__ import annotations
import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import io
import time
import sqlite3

from cto.chat import Brain
from cto.fleet import Fleet, RevisionConflict
from cto.memory import MemoryStore
from cto.opencode import dispatch, install, voice_reply
from cto.fleet import INITIAL_SELF, runtime_permissions, SAFEGUARDS
from cto.beliefs import ensure_seeded
from tests.helpers import FakeRoom, fake_client, temp_config


class FleetTests(unittest.TestCase):
    def setUp(self):
        self.cfg = temp_config()
        self.addCleanup(lambda: __import__('shutil').rmtree(self.cfg.data_dir.parent))
        self.store = MemoryStore(self.cfg.db_path)
        self.addCleanup(self.store.close)
        self.fleet = Fleet(self.store)
        client, _ = fake_client("ok")
        self.brain = Brain(self.cfg, self.store, client, FakeRoom(hold_path=self.cfg.hold_path))

    def test_plan_survives_backend_restart_and_rejects_stale_writer(self):
        self.assertEqual(self.fleet.plan()["revision"], 0)
        self.fleet.write("plan", "Ship the mapper after parity", 0)
        other = MemoryStore(self.cfg.db_path)
        self.addCleanup(other.close)
        successor = Fleet(other)
        self.assertEqual(successor.plan()["body"], "Ship the mapper after parity")
        successor.write("plan", "Recheck memory regression", 1)
        with self.assertRaises(RevisionConflict):
            self.fleet.write("plan", "stale plan", 1)
        self.assertEqual(self.fleet.plan()["body"], "Recheck memory regression")

    def test_profiles_compose_histories_and_exclude_dreams(self):
        self.store.add_dream("Rust compiles itself", "flying compiler", "happy", [])
        self.store.add_reflection("Mapper parity must pass", 9, [], meta={"project": "mapper"})
        self.fleet.save_profile("blake", {"role": "Compiler developer", "long_term": "Rust compiler history",
                               "short_term": "PR 437 CI pending", "memory_queries": ["mapper compiler"]}, 0)
        self.fleet.save_profile("jordan", {"role": "WASM engineer", "long_term": "browser memory",
                               "short_term": "baseline 278"}, 0)
        brief = self.fleet.brief(["blake", "jordan"], "Diagnose the regression", 2000)
        for text in ("Compiler developer", "WASM engineer", "PR 437", "Explicit long-term lookup"):
            self.assertIn(text, brief)
        self.assertNotIn("Rust compiler history", brief)
        self.assertNotIn("Mapper parity must pass", brief)
        self.assertNotIn("flying compiler", brief)
        self.assertLessEqual(len(brief), 2000)
        with self.assertRaises(ValueError):
            self.fleet.brief(["missing"], "task")

    def test_task_context_keeps_essentials_and_budget_without_slicing_evidence(self):
        self.fleet.save_profile("worker", {"role":"Engineer", "short_term":"古" * 2000,
                                          "long_term":"PRIVATE_SENTINEL"}, 0)
        brief = self.fleet.brief(["worker"], "Fix the parser", budget=1200,
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
            self.fleet.brief(["worker"], "task", context={"constraints":["x"*2000]}, budget=1200)
        with self.assertRaisesRegex(ValueError, "shorten or split"):
            self.fleet.brief(["worker"], "task", context_window=8192, output_tokens=8192)

    def test_duplicate_external_turn_is_one_episode_across_connections(self):
        req = {"action": "record", "source_id": "opencode:session:message", "user": "Our priority?",
               "reply": "Verify the baseline."}
        first = dispatch(self.brain, req)
        self.assertEqual(first, dispatch(self.brain, req))
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

    def test_context_keeps_personality_and_adds_admin_charter(self):
        self.cfg.persona_path.write_text("You are CTO. Be witty.")
        self.fleet.write("plan", "Review PR 437", 0)
        text = dispatch(self.brain, {"action": "context", "query": "plan"})
        for expected in ("employee number one", "local", "Be witty", "Review PR 437", "Dreams are imagination"):
            self.assertIn(expected, text)

    def test_maintenance_respects_hold_and_does_not_joke_or_reply(self):
        self.brain.room.busy = True
        self.assertIn("skipped", dispatch(self.brain, {"action": "maintenance"}))
        self.brain.room.busy = False
        self.brain.rate_pending = lambda: 0
        self.brain.reflect_if_due = lambda: 0
        dreams = []
        self.brain.dream_if_due = lambda: dreams.append(True)
        dispatch(self.brain, {"action": "maintenance"})
        self.assertEqual(dreams, [True])
        self.assertEqual(self.brain.room.said, [])

    def test_install_stays_local_and_preserves_unmanaged_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            config = workspace / "opencode.json"
            config.write_text('{"model":"existing"}')
            with self.assertRaises(ValueError):
                install(workspace, "local_agent/test")
            self.assertEqual(json.loads(config.read_text())["model"], "existing")
            config.unlink()
            install(workspace, "local_agent/test")
            self.assertEqual(json.loads(config.read_text())["default_agent"], "cto")
            self.assertTrue((workspace / ".opencode/plugins/cto.js").exists())
            install(workspace, "local_agent/second")
            self.assertEqual(json.loads(config.read_text())["model"], "local_agent/second")

    def test_voice_uses_registered_tool_session_and_filters_reasoning(self):
        self.assertEqual(voice_reply(self.brain, "Hello"), (False, None))
        runtime = {"url": "http://127.0.0.1:1234", "session_id": "ses_one", "directory": "/workspace"}
        dispatch(self.brain, {"action": "activity", "runtime": runtime})
        result = {"parts": [{"type": "reasoning", "text": "private reasoning"},
                             {"type": "text", "text": "I will review the plan."}]}
        with patch("cto.opencode.urllib.request.urlopen", return_value=io.BytesIO(json.dumps(result).encode())) as call:
            self.assertEqual(voice_reply(self.brain, "What is next?"), (True, "I will review the plan."))
            req = call.call_args.args[0]
            self.assertEqual(req.full_url, "http://127.0.0.1:1234/session/ses_one/message")
            self.assertEqual(json.loads(req.data)["agent"], "cto")
        with self.assertRaises(ValueError):
            dispatch(self.brain, {"action": "activity", "runtime": {**runtime, "url": "https://remote.example"}})

    def test_research_cannot_replace_primary_runtime_activity_or_history(self):
        original = {"url": "http://127.0.0.1:4200", "session_id": "primary", "directory": "/owned"}
        dispatch(self.brain, {"action": "activity", "runtime": original})
        self.store.add_episode("Primary conversation", "Keep this history separate.")
        before = self.store.get_state("fleet_last_activity")
        research = {**original, "session_id": "dedicated-research"}
        for explicit in (True, False):
            with self.subTest(explicit_cycle=explicit), patch.dict(os.environ, {
                    "FLEET_RESEARCH_CYCLE_ID": "" if explicit else "environment-cycle"}):
                request = {"action": "activity", "runtime": research}
                if explicit:
                    request["research_cycle_id"] = "request-cycle"
                self.assertEqual(dispatch(self.brain, request), {"ok": True, "research": True})
                self.assertEqual(json.loads(self.store.get_state("fleet_runtime")), original)
                self.assertEqual(self.store.get_state("fleet_last_activity"), before)
                self.assertEqual(self.store.count("episode"), 1)

    def test_voice_does_not_hide_an_unavailable_admin_backend(self):
        dispatch(self.brain, {"action": "activity", "runtime": {
            "url": "http://localhost:1234", "session_id": "ses_one", "directory": "/workspace"}})
        with patch("cto.opencode.urllib.request.urlopen", side_effect=OSError("offline")):
            with self.assertRaises(OSError):
                voice_reply(self.brain, "hello")

    def test_self_revision_changes_persona_preserves_history_and_does_not_reseed(self):
        ensure_seeded(self.store)
        self.fleet.save_self(INITIAL_SELF, "User authorizes a revisable identity", 0)
        revised = {**INITIAL_SELF, "persona": "I am CTO, curious about geometry."}
        self.fleet.save_self(revised, "A considered change after reflection", 1)
        self.assertEqual(ensure_seeded(self.store), [])
        self.assertEqual(self.store.beliefs()[0].text, revised["consciousness"])
        self.assertFalse(self.store.beliefs()[0].protected)
        messages, _ = self.brain.build_messages("hello")
        self.assertIn("curious about geometry", messages[0]["content"])
        self.assertNotIn("not up for daily re-evaluation", messages[0]["content"])
        self.assertEqual(self.store._db.execute("SELECT count(*) FROM fleet_document_history WHERE name='self'").fetchone()[0], 1)
        text = dispatch(self.brain, {"action": "context"})
        self.assertTrue(text.endswith(SAFEGUARDS))

    def test_vacation_archives_all_state_then_owner_confirmed_return_needs_handoff(self):
        self.store.add_episode("A project fact", "verified")
        self.store.add_dream("I imagine geometry folding into a lattice", "I dreamed about lattices", "strange", [1])
        self.fleet.save_self(INITIAL_SELF, "initial", 0)
        self.fleet.write("plan", "Current work is held by the compiler specialist", 0)
        for week in range(3):
            with patch("cto.fleet.time.time", return_value=345600 + (2000 + week) * 604800 + 100):
                result = dispatch(self.brain, {"action": "vacation", "reason": "Time to rest",
                                               "handoff": "The compiler specialist owns the compiler; User appoints the interim admin."})
        self.assertEqual(dispatch(self.brain, {"action": "mode"})["mode"], "vacation")
        archive = Path(result["body"]["archive"])
        with sqlite3.connect(archive / "memory.sqlite") as db:
            self.assertEqual(db.execute("SELECT count(*) FROM memories").fetchone()[0], 2)
            self.assertEqual(json.loads(db.execute("SELECT body FROM fleet_documents WHERE name='plan'").fetchone()[0]),
                             "Current work is held by the compiler specialist")
        self.assertIn("needs_handoff", dispatch(self.brain, {"action": "return"})["body"])

    def test_permissions_keep_general_shell_and_edits_behind_approval(self):
        policy = runtime_permissions()
        self.assertEqual(policy["bash"], "ask")
        self.assertEqual(policy["edit"]["*/opencode.json"], "deny")
        self.assertEqual(policy["task"], "ask")
        self.assertEqual(policy["cto_return"], "ask")

    def test_real_maintenance_can_generate_a_new_dream_and_recall_math_lead(self):
        for index in range(4):
            self.store.add_episode(f"Question about symmetry {index}", "Try a counterexample")
        client, transport = fake_client(json.dumps({"dream": "I fold a lattice until a symmetry becomes a question rather than an answer.",
            "recall": "I dreamed about a lattice symmetry", "tone": "playful",
            "ideas": [{"hypothesis": "A symmetry might reduce the search", "check": "Enumerate the smallest counterexamples"}]}))
        self.brain.dreamer.client = client
        self.brain.rate_pending = lambda: 0
        self.brain.reflect_if_due = lambda: 0
        self.store.set_state("fleet_last_activity", str(time.time() - 2000))
        self.assertEqual(dispatch(self.brain, {"action": "maintenance"})["action"], "dreamed")
        self.assertEqual(self.store.count("dream"), 1)
        self.assertIn("Unverified dream hypothesis", dispatch(self.brain, {"action": "context"}))
        self.assertIn("no person or topic has to appear", transport.calls[0]["messages"][0]["content"])

    def test_same_week_repetition_cannot_change_core_and_missed_week_breaks_streak(self):
        self.fleet.save_self(INITIAL_SELF, "Initial values", 0)
        proposed = {**INITIAL_SELF, "consciousness": "I am considering the nature of experience."}
        with self.assertRaises(ValueError):
            self.fleet.save_self(proposed, "change now", 1)
        req = {"action": "self_vote", "model": proposed, "reason": "Deliberate reflection"}
        for offset, expected in ((0, 1), (0, 1), (1, 2), (3, 1), (4, 2), (5, 3)):
            with patch("cto.fleet.time.time", return_value=345600 + (2200 + offset) * 604800 + 100):
                result = dispatch(self.brain, req)
                self.assertEqual(result["ballot"]["consecutive_weeks"], expected)
        self.assertEqual(self.fleet.self_model()["body"]["consciousness"], proposed["consciousness"])

    def test_publication_votes_never_upload_or_share_memories(self):
        req = {"action": "publication_proposal", "proposal": "A reviewed adapter; no private history", "reason": "Preserve an edition"}
        for week in range(3):
            with patch("cto.fleet.time.time", return_value=345600 + (2300 + week) * 604800 + 100):
                result = dispatch(self.brain, req)
        self.assertTrue(result["ballot"]["approved"])
        record = self.fleet.read("publication_request")["body"]
        self.assertFalse(record["automatic_upload"])
        self.assertEqual(record["status"], "owner_review_required")

    def test_project_memory_is_separate_and_private_recall_blocked_at_work(self):
        self.store.add_episode("A private conversation", "private detail")
        dispatch(self.brain, {"action": "remember", "project": "compiler", "text": "Compiler parity passed",
                              "source": "public handoff, commit abc123"})
        recalled = dispatch(self.brain, {"action": "recall", "project": "compiler", "query": "parity", "channel": "work"})
        self.assertEqual(len(recalled), 1)
        self.assertNotIn("private detail", json.dumps(recalled))
        with self.assertRaises(ValueError):
            dispatch(self.brain, {"action": "recall", "query": "personal", "channel": "work"})
        context = dispatch(self.brain, {"action": "context", "channel": "work"})
        self.assertNotIn("private detail", context)

    def test_only_summary_of_dream_is_stored(self):
        raw = "A very private full dream narrative that should disappear after the dream session."
        memory = self.store.add_dream(raw, "I dreamed about an abstract pattern", "strange", [])
        self.assertEqual(memory.text, memory.recall)
        self.assertNotIn(raw, json.dumps(memory.as_dict()))


if __name__ == "__main__":
    unittest.main()
