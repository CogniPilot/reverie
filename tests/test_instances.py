from __future__ import annotations
import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from reverie.config import Config
from reverie.chat import ChatDaemon
from reverie.context_budget import memory_byte_budget, recent_exchanges
from reverie.reverie import Reverie
from reverie.opencode import dispatch, install

class InstanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def instance(self, name):
        path = self.root / (name + ".json")
        path.write_text(json.dumps({"id": name, "agent_name": "CTO", "owner_name": "Owner",
            "data_dir": "state/" + name, "persona": "Teach carefully and be curious.",
            "initial_self": {"consciousness": "Consciousness is an open question.",
                             "directives": ["Be honest and inquisitive."]}}))
        return path

    def daemon(self, path):
        daemon = ChatDaemon(cfg=Config(instance_config=path))
        self.addCleanup(daemon.brain.store.close)
        return daemon

    def test_shared_room_tone_defaults_to_professional_and_is_validated(self):
        from reverie.instance import load_instance
        self.assertEqual(load_instance(self.instance("plain")).shared_room_tone, "professional")
        for tone, ok in (("social", True), ("professional", True), ("personal", False), ("spicy", False), (3, False)):
            path = self.instance("tone")
            raw = json.loads(path.read_text()); raw["shared_room_tone"] = tone; path.write_text(json.dumps(raw))
            if ok:
                self.assertEqual(load_instance(path).shared_room_tone, tone)
            else:
                with self.assertRaises(ValueError):
                    load_instance(path)

    def test_shared_instance_does_not_share_memories_or_legacy_paths(self):
        personal = self.daemon(self.instance("personal"))
        shared = self.daemon(self.instance("shared"))
        personal.brain.store.add_episode("PRIVATE_SENTINEL_739", "Only for personal history.")
        self.assertEqual(shared.brain.store.count("episode"), 0)
        self.assertNotIn("PRIVATE_SENTINEL_739", dispatch(shared.brain, {"action":"context"}))
        self.assertNotEqual(personal.cfg.db_path, shared.cfg.db_path)
        for path in (shared.cfg.persona_path, shared.cfg.profile_path,
                     shared.cfg.legacy_history, shared.cfg.log_path):
            self.assertTrue(path.is_relative_to(shared.cfg.data_dir))
        self.assertEqual(Reverie(shared.brain.store).self_model()["body"]["consciousness"],
                         "Consciousness is an open question.")
        self.assertEqual(shared.brain.store.beliefs(), [])

    def test_model_switch_preserves_history_self_model_plan_and_ballots(self):
        config = self.instance("personal")
        daemon = self.daemon(config)
        daemon.brain.store.add_episode("My ongoing task", "Validate the compiler.")
        reverie = Reverie(daemon.brain.store)
        reverie.write("plan", "Continue the experiment", 0)
        reverie.vote("publication", {"proposal":"A reviewed public package"}, "Deliberate first vote")
        before = (reverie.self_model(), reverie.plan(), reverie.ballot_history())
        workspace = self.root / "runtime"
        install(workspace, "local/small", config)
        install(workspace, "cloud/large", config)
        reopened = self.daemon(config)
        after = Reverie(reopened.brain.store)
        self.assertEqual(before, (after.self_model(), after.plan(), after.ballot_history()))
        self.assertEqual(reopened.brain.store.count("episode"), 1)
        self.assertEqual(json.loads((workspace/".reverie-instance").read_text())["instance"], str(config.resolve()))
        self.assertEqual(json.loads((workspace/"opencode.json").read_text())["model"], "cloud/large")
        self.assertTrue((workspace/".agents/skills/reverie-memory/SKILL.md").is_file())
        self.assertTrue((workspace/".claude/skills/reverie-runtime/SKILL.md").is_file())
        instructions = (workspace/"AGENTS.md").read_text()
        self.assertIn("reverie.context_cli", instructions)
        self.assertEqual(instructions.count("<!-- reverie:begin -->"), 1)

    def test_invalid_or_missing_config_never_falls_back_to_personal_data(self):
        with self.assertRaises(FileNotFoundError):
            Config(instance_config=self.root/"missing.json")
        path = self.instance("bad")
        value = json.loads(path.read_text()); value["credentials"] = "unexpected"; path.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            Config(instance_config=path)
        with patch.dict(os.environ, {"PYTHONPATH": str(Path(__file__).resolve().parents[1] / "python")}, clear=True):
            result = subprocess.run([sys.executable, "-m", "reverie.memory_cli"], input="{}",
                                    text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("select an instance", result.stderr)

    def test_context_budget_scales_and_reserves_tools_and_output(self):
        small = memory_byte_budget(8192, 2048, 1000, "fixed rules")
        large = memory_byte_budget(131072, 8192, 1000, "fixed rules")
        self.assertGreater(large, small)
        messages = []
        for i in range(30):
            messages.extend([{"role":"user", "content":str(i)+"x"*100},
                             {"role":"assistant", "content":"y"*100}])
        self.assertLessEqual(len(recent_exchanges(messages, small).encode()), small)
        self.assertIn("user: 29", recent_exchanges(messages, small))
        self.assertEqual(recent_exchanges(messages, 0), "")
        self.assertEqual(memory_byte_budget(8192, 8192), 0)
        with self.assertRaises(ValueError):
            memory_byte_budget(-1)

    def test_local_gpu_provider_uses_selected_endpoint_limits_and_environment_credential(self):
        workspace=self.root/"gpu-runtime"
        install(workspace, "local_agent/qwen", self.instance("gpu"),
                "http://gpu:8080/v1", 32768, 4096, "LOCAL_MODEL_KEY")
        settings=json.loads((workspace/"opencode.json").read_text())
        provider=settings["provider"]["local_agent"]
        self.assertEqual(provider["options"]["apiKey"], "{env:LOCAL_MODEL_KEY}")
        self.assertEqual(provider["options"]["baseURL"], "http://gpu:8080/v1")
        self.assertEqual(provider["models"]["qwen"]["limit"], {"context":32768,"output":4096})
        self.assertTrue((workspace/".agents/skills/reverie-context/SKILL.md").exists())
        before=(workspace/"opencode.json").read_text()
        with self.assertRaises(ValueError):
            install(workspace,"local_agent/qwen",api_base="http://user:secret@gpu/v1")
        self.assertEqual((workspace/"opencode.json").read_text(),before)
