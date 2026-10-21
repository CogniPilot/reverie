import unittest
from types import SimpleNamespace
import tempfile
from pathlib import Path

from cto.fleet import CHARTER, role_charter
from cto.opencode import CHAT_TOOLS


class InteractionRoleTest(unittest.TestCase):
    def test_owner_role_overrides_legacy_runtime_kind(self):
        charter = role_charter(SimpleNamespace(kind="cto", role="Administrative Assistant"))
        self.assertIn("Your role is Administrative Assistant", charter)
        self.assertNotIn("You are the CTO, employee number one", charter)

    def test_local_agent_has_no_organizational_authority_and_installs_both_modes(self):
        import json
        from cto.instance import load_instance, primary_agent
        from cto.opencode import install
        from cto.backend import argv_for
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
            self.assertEqual(primary_agent(instance), "chat")
            self.assertEqual(argv_for("opencode", "local/model", primary_agent(instance)),
                ["opencode", "--agent", "chat", "--model", "local/model"])
            import io
            from types import SimpleNamespace
            from unittest.mock import patch
            from cto.opencode import voice_reply
            class Store:
                def get_state(self, key):
                    return json.dumps({"url": "http://localhost:4096", "session_id": "native-session", "directory": str(root)})
            brain = SimpleNamespace(store=Store(), cfg=SimpleNamespace(instance=instance, request_timeout=2))
            requests = []
            def reply(request, **kwargs):
                requests.append(json.loads(request.data))
                return io.BytesIO(b'{"parts":[{"type":"text","text":"Hello"}]}')
            with patch("cto.opencode.urllib.request.urlopen", side_effect=reply):
                self.assertEqual(voice_reply(brain, "Hello"), (True, "Hello"))
            self.assertEqual(requests[0]["agent"], "chat")
            workspace = root / "workspace"
            install(workspace, "local/model", config)
            settings = json.loads((workspace / "opencode.json").read_text())
            self.assertEqual(settings["default_agent"], "chat")
            self.assertEqual(set(settings["agent"]), {"chat", "coding"})
            chat, coding = settings["agent"]["chat"], settings["agent"]["coding"]
            self.assertEqual(chat["permission"]["*"], "deny")                       # conversation is lean
            self.assertEqual({k for k, v in chat["permission"].items() if v == "allow"}, set(CHAT_TOOLS))
            self.assertNotEqual(coding["permission"].get("*"), "deny")              # the coding agent keeps the toolset
            self.assertEqual(coding["steps"], 24)
            policy = workspace / ".opencode/interaction-policy.json"
            self.assertTrue(json.loads(policy.read_text())["enabled"])
            self.assertEqual(json.loads(policy.read_text())["coding_agent"], "coding")
            policy.write_text('{"enabled": false}')                                   # an older owner-edited policy
            install(workspace, "local/model", config)
            kept = json.loads(policy.read_text())
            self.assertFalse(kept["enabled"])
            self.assertEqual(kept["coding_agent"], "coding")                        # upgraded, never stranded
            policy.write_text('{"enabled": true, "coding_agent": "ops"}')             # an explicit owner choice stays
            install(workspace, "local/model", config)
            self.assertEqual(json.loads(policy.read_text())["coding_agent"], "ops")

    def test_chat_tools_match_the_plugin_allowlist(self):
        import re
        source = (Path(__file__).resolve().parent.parent / "cto/plugins/interaction.mjs").read_text()
        allowed = re.search(r"const allowed = \[([^\]]*)\]", source).group(1)
        self.assertEqual(set(re.findall(r"'([a-z_]+)'", allowed)), set(CHAT_TOOLS))

    def test_cto_defaults_keep_their_charter(self):
        self.assertEqual(role_charter(), CHARTER)
        self.assertEqual(role_charter(SimpleNamespace(kind="cto", role="CTO")), CHARTER)
        self.assertEqual(role_charter(SimpleNamespace(kind="cto", role="Chief Technology Officer")), CHARTER)

    def test_other_roles_keep_the_existing_generic_rules(self):
        for kind in ("expert", "implementer"):
            charter = role_charter(SimpleNamespace(kind=kind, role="Research specialist"))
            self.assertIn("Your role is Research specialist", charter)
            self.assertIn("Save a bounded handoff", charter)

    def test_installer_deploys_the_plugin_and_its_resolvable_core(self):
        from cto.opencode import install
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            install(workspace, "provider/model")
            plugin = workspace / ".opencode/plugins/zz-interaction.js"
            self.assertIn("../lib/interaction.mjs", plugin.read_text())
            self.assertTrue((plugin.parent / "../lib/interaction.mjs").resolve().is_file())


if __name__ == "__main__":
    unittest.main()
