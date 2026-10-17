from __future__ import annotations
import tests  # noqa: F401  isolates CODEMAN_*/FLEET_* before cto is imported
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from cto.config import Config
from cto.chat import ChatDaemon
from cto.context_budget import memory_byte_budget, recent_exchanges
from cto.fleet import Fleet
from cto.opencode import dispatch, install

class InstanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def instance(self, name):
        path = self.root / (name + ".json")
        path.write_text(json.dumps({"id": name, "agent_name": "CTO", "owner_name": "Instructor",
            "data_dir": "state/" + name, "persona": "Teach carefully and be curious.",
            "initial_self": {"consciousness": "Consciousness is an open question.",
                             "directives": ["Be honest and inquisitive."]}}))
        return path

    def daemon(self, path):
        daemon = ChatDaemon(cfg=Config(instance_config=path))
        self.addCleanup(daemon.brain.store.close)
        return daemon

    def test_instances_do_not_share_memories_or_legacy_paths(self):
        personal = self.daemon(self.instance("personal"))
        shared = self.daemon(self.instance("shared"))
        personal.brain.store.add_episode("PRIVATE_SENTINEL_739", "Only for personal history.")
        self.assertEqual(shared.brain.store.count("episode"), 0)
        self.assertNotIn("PRIVATE_SENTINEL_739", dispatch(shared.brain, {"action":"context"}))
        self.assertNotEqual(personal.cfg.db_path, shared.cfg.db_path)
        for path in (shared.cfg.persona_path, shared.cfg.profile_path,
                     shared.cfg.legacy_history, shared.cfg.log_path):
            self.assertTrue(path.is_relative_to(shared.cfg.data_dir))
        self.assertEqual(Fleet(shared.brain.store).self_model()["body"]["consciousness"],
                         "Consciousness is an open question.")
        self.assertEqual(shared.brain.store.beliefs(), [])

    def test_model_switch_preserves_history_self_model_plan_and_ballots(self):
        config = self.instance("personal")
        daemon = self.daemon(config)
        daemon.brain.store.add_episode("My ongoing task", "Validate the compiler.")
        fleet = Fleet(daemon.brain.store)
        fleet.write("plan", "Continue the experiment", 0)
        fleet.vote("publication", {"proposal":"A reviewed public package"}, "Deliberate first vote")
        before = (fleet.self_model(), fleet.plan(), fleet.ballot_history())
        workspace = self.root / "runtime"
        install(workspace, "local/small", config)
        install(workspace, "cloud/large", config)
        reopened = self.daemon(config)
        after = Fleet(reopened.brain.store)
        self.assertEqual(before, (after.self_model(), after.plan(), after.ballot_history()))
        self.assertEqual(reopened.brain.store.count("episode"), 1)
        self.assertEqual(json.loads((workspace/".fleet-instance").read_text())["instance"], str(config.resolve()))
        self.assertEqual(json.loads((workspace/"opencode.json").read_text())["model"], "cloud/large")
        self.assertTrue((workspace/".agents/skills/fleet-memory/SKILL.md").is_file())
        self.assertTrue((workspace/".claude/skills/fleet-runtime/SKILL.md").is_file())
        instructions = (workspace/"AGENTS.md").read_text()
        self.assertIn("cto.context_cli", instructions)
        self.assertEqual(instructions.count("<!-- agent-fleet:begin -->"), 1)

    def test_invalid_or_missing_config_never_falls_back_to_personal_data(self):
        with self.assertRaises(FileNotFoundError):
            Config(instance_config=self.root/"missing.json")
        path = self.instance("bad")
        value = json.loads(path.read_text()); value["credentials"] = "unexpected"; path.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            Config(instance_config=path)
        with patch.dict(os.environ, {}, clear=True):
            result = subprocess.run([sys.executable, "-m", "cto.memory_cli"], input="{}",
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
        self.assertTrue((workspace/".agents/skills/fleet-context/SKILL.md").exists())
        before=(workspace/"opencode.json").read_text()
        with self.assertRaises(ValueError):
            install(workspace,"local_agent/qwen",api_base="http://user:secret@gpu/v1")
        self.assertEqual((workspace/"opencode.json").read_text(),before)
