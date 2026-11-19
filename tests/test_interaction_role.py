import unittest
from types import SimpleNamespace
import tempfile
from pathlib import Path
import subprocess

from reverie.reverie import role_charter
from tests.helpers import install_opencode

CHARTER = "You are a persistent AI agent and expert."


class InteractionRoleTest(unittest.TestCase):
    def test_owner_role_overrides_legacy_runtime_kind(self):
        charter = role_charter(SimpleNamespace(kind="cto", role="Administrative Assistant"))
        self.assertIn("Your role is Administrative Assistant", charter)
        self.assertNotIn("You are the CTO, employee number one", charter)

    def test_local_agent_has_no_organizational_authority_and_installs_both_modes(self):
        import json
        from reverie.instance import load_instance
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / "instance.json"
            config.write_text(json.dumps({"id": "local-agent", "agent_name": "Assistant",
                "owner_name": "Owner", "data_dir": "memory", "persona": "Be attentive.",
                "kind": "agent", "role": "Local Agent"}))
            instance = load_instance(config)
            charter = role_charter(instance)
            self.assertIn("Conversation is first class", charter)
            self.assertIn("Only the owner controls your permissions", charter)
            self.assertNotIn("The CTO controls model selection", charter)
            workspace = root / "workspace"
            install_opencode(workspace, "--model", "local/model", "--instance", str(config))
            settings = json.loads((workspace / "opencode.json").read_text())
            self.assertEqual(settings["default_agent"], "chat")
            self.assertEqual(set(settings["agent"]), {"chat", "coding"})
            chat, coding = settings["agent"]["chat"], settings["agent"]["coding"]
            self.assertEqual(chat["permission"]["*"], "deny")                       # conversation is lean
            self.assertEqual({k for k, v in chat["permission"].items() if v == "allow"}, {"interaction_mode", "reverie_memory", "reverie_room", "agent_profile"})
            self.assertNotEqual(coding["permission"].get("*"), "deny")              # the coding agent keeps the toolset
            self.assertEqual(coding["steps"], 24)
            policy = workspace / ".opencode/interaction-policy.json"
            self.assertTrue(json.loads(policy.read_text())["enabled"])
            self.assertEqual(json.loads(policy.read_text())["coding_agent"], "coding")
            policy.write_text('{"enabled": false}')                                   # an older owner-edited policy
            install_opencode(workspace, "--model", "local/model", "--instance", str(config))
            kept = json.loads(policy.read_text())
            self.assertFalse(kept["enabled"])
            self.assertEqual(kept["coding_agent"], "coding")                        # upgraded, never stranded
            policy.write_text('{"enabled": true, "coding_agent": "ops"}')             # an explicit owner choice stays
            install_opencode(workspace, "--model", "local/model", "--instance", str(config))
            self.assertEqual(json.loads(policy.read_text())["coding_agent"], "ops")

    def test_all_titles_and_legacy_kinds_share_memory_and_tool_gates(self):
        import json
        from reverie.config import Config
        from reverie.memory import MemoryStore
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            policies = []
            stores = []
            for role, kind in (("CTO", "cto"), ("COO", "expert"), ("Researcher", "agent")):
                config = root / (role + ".json")
                config.write_text(json.dumps({"id": role, "agent_name": role, "owner_name": "Owner",
                    "data_dir": role + "-memory", "persona": "Be curious.", "role": role, "kind": kind}))
                subprocess.run(["reverie-chat", "--instance", str(config), "--profile"],
                               capture_output=True, check=True, timeout=10)
                database = Config(instance_config=config).db_path
                store = MemoryStore(database)
                try:
                    store.add_episode(role + " private memory", "Keep this private.")
                    self.assertEqual(store.count("episode"), 1)
                    stores.append(database)
                finally:
                    store.close()
                workspace = root / (role + "-workspace")
                # A container marker is deployment context, not an owner grant.
                with patch.dict("os.environ", {"REVERIE_CONTAINER": "1"}):
                    install_opencode(workspace, "--model", "local/model", "--instance", str(config))
                settings = json.loads((workspace / "opencode.json").read_text())
                policies.append(settings["agent"]["coding"]["permission"])
                self.assertEqual(settings["default_agent"], "chat")
            self.assertEqual(len(set(stores)), 3)
            self.assertEqual(policies[0], policies[1])
            self.assertEqual(policies[1], policies[2])
            self.assertEqual(policies[0]["bash"], "ask")

    def test_chat_tools_match_the_plugin_allowlist(self):
        import re
        source = (Path(__file__).resolve().parent.parent / "crates/reverie-admin-memory/opencode-assets/plugins/interaction.mjs").read_text()
        allowed = re.search(r"const allowed = \[([^\]]*)\]", source).group(1)
        self.assertEqual(set(re.findall(r"'([a-z_]+)'", allowed)), {"interaction_mode", "reverie_memory", "reverie_room", "agent_profile"})

    def test_cto_defaults_keep_their_charter(self):
        self.assertIn(CHARTER, role_charter())
        self.assertIn(CHARTER, role_charter(SimpleNamespace(kind="cto", role="CTO")))
        self.assertIn(CHARTER, role_charter(SimpleNamespace(kind="cto", role="Chief Technology Officer")))

    def test_other_roles_keep_the_existing_generic_rules(self):
        for kind in ("expert", "implementer"):
            charter = role_charter(SimpleNamespace(kind=kind, role="Research specialist"))
            self.assertIn("Your role is Research specialist", charter)
            self.assertIn("Save a bounded handoff", charter)

    def test_default_prompt_sources_do_not_assign_a_privileged_title(self):
        from reverie.persona import DEFAULT_PERSONA
        root = Path(__file__).resolve().parent.parent
        rules = (root / "crates/reverie-admin-memory/opencode-assets/rules.md").read_text()
        self.assertNotIn("You are the CTO", DEFAULT_PERSONA + CHARTER + rules)
        self.assertIn("titles grant no permissions", rules)
        for role in ("CTO", "COO", "Researcher"):
            charter = role_charter(SimpleNamespace(kind="agent", role=role))
            self.assertIn("Your role is " + role, charter)
            self.assertIn("Only explicit owner policy grants permissions", charter)

    def test_installer_deploys_the_plugin_and_its_resolvable_core(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            install_opencode(workspace, "--model", "provider/model")
            plugin = workspace / ".opencode/plugins/zz-interaction.js"
            self.assertIn("../lib/interaction.mjs", plugin.read_text())
            self.assertTrue((plugin.parent / "../lib/interaction.mjs").resolve().is_file())


if __name__ == "__main__":
    unittest.main()
