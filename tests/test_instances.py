from __future__ import annotations
import tests  # noqa: F401  isolates REVERIE_* before reverie is imported
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from reverie.config import Config
from reverie.memory import MemoryStore
from reverie.reverie import Reverie
from tests.helpers import install_opencode

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

    def memory(self, path):
        subprocess.run(["reverie-chat", "--instance", str(path), "--profile"],
                       capture_output=True, check=True, timeout=10)
        cfg = Config(instance_config=path)
        store = MemoryStore(cfg.db_path)
        self.addCleanup(store.close)
        return cfg, store

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
        personal_cfg, personal = self.memory(self.instance("personal"))
        shared_cfg, shared = self.memory(self.instance("shared"))
        personal.add_episode("PRIVATE_SENTINEL_739", "Only for personal history.")
        self.assertEqual(shared.count("episode"), 0)
        context = subprocess.check_output(
            ["reverie-context", "--instance", str(shared_cfg.instance_config), "--channel", "private"],
            text=True, timeout=10,
        )
        self.assertNotIn("PRIVATE_SENTINEL_739", context)
        self.assertNotEqual(personal_cfg.db_path, shared_cfg.db_path)
        for path in (shared_cfg.persona_path, shared_cfg.profile_path,
                     shared_cfg.legacy_history, shared_cfg.log_path):
            self.assertTrue(path.is_relative_to(shared_cfg.data_dir))
        self.assertEqual(Reverie(shared).self_model()["body"]["consciousness"],
                         "Consciousness is an open question.")
        self.assertEqual(shared.beliefs(), [])

    def test_model_switch_preserves_history_self_model_plan_and_ballots(self):
        config = self.instance("personal")
        _, store = self.memory(config)
        store.add_episode("My ongoing task", "Validate the compiler.")
        reverie = Reverie(store)
        reverie.write("plan", "Continue the experiment", 0)
        reverie.vote("publication", {"proposal":"A reviewed public package"}, "Deliberate first vote")
        before = (reverie.self_model(), reverie.plan(), reverie.ballot_history())
        workspace = self.root / "runtime"
        install_opencode(workspace, "--model", "local/small", "--instance", str(config))
        install_opencode(workspace, "--model", "cloud/large", "--instance", str(config))
        _, reopened = self.memory(config)
        after = Reverie(reopened)
        self.assertEqual(before, (after.self_model(), after.plan(), after.ballot_history()))
        self.assertEqual(reopened.count("episode"), 1)
        self.assertEqual(json.loads((workspace/".reverie-instance").read_text())["instance"], str(config.resolve()))
        self.assertEqual(json.loads((workspace/"opencode.json").read_text())["model"], "cloud/large")
        self.assertTrue((workspace/".agents/skills/reverie-memory/SKILL.md").is_file())
        self.assertTrue((workspace/".claude/skills/reverie-runtime/SKILL.md").is_file())
        instructions = (workspace/"AGENTS.md").read_text()
        self.assertIn("reverie-context --instance", instructions)
        self.assertEqual(instructions.count("<!-- reverie:begin -->"), 1)

    def test_invalid_or_missing_config_never_falls_back_to_personal_data(self):
        with self.assertRaises(FileNotFoundError):
            Config(instance_config=self.root/"missing.json")
        path = self.instance("bad")
        value = json.loads(path.read_text()); value["credentials"] = "unexpected"; path.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            Config(instance_config=path)

    def test_local_gpu_provider_uses_selected_endpoint_limits_and_environment_credential(self):
        workspace=self.root/"gpu-runtime"
        install_opencode(workspace, "--model", "local_agent/qwen", "--instance", str(self.instance("gpu")),
                         "--api-base", "http://gpu:8080/v1", "--context-window", "32768",
                         "--output-tokens", "4096", "--api-key-env", "LOCAL_MODEL_KEY")
        settings=json.loads((workspace/"opencode.json").read_text())
        provider=settings["provider"]["local_agent"]
        self.assertEqual(provider["options"]["apiKey"], "{env:LOCAL_MODEL_KEY}")
        self.assertEqual(provider["options"]["baseURL"], "http://gpu:8080/v1")
        self.assertEqual(provider["models"]["qwen"]["limit"], {"context":32768,"output":4096})
        self.assertTrue((workspace/".agents/skills/reverie-context/SKILL.md").exists())
        before=(workspace/"opencode.json").read_text()
        with self.assertRaises(subprocess.CalledProcessError):
            install_opencode(workspace, "--model", "local_agent/qwen", "--api-base", "http://user:secret@gpu/v1")
        self.assertEqual((workspace/"opencode.json").read_text(),before)
