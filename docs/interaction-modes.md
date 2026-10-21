# Conversation and coding modes

OpenCode can keep one identity and conversation while changing its working mode.
The optional interaction plugin defaults to chat. The agent can select coding for a
bounded request with `interaction_mode`, then return to chat when done or blocked.
A fresh user message returns attention to the conversation. A coding budget cannot
be renewed by another automatic turn or by switching modes back and forth.

Run the normal OpenCode workspace installer to install the plugin and its library.
Enable it with an owner-controlled `.opencode/interaction-policy.json` in that
workspace:

```json
{"enabled": true, "role": "assistant", "max_continuations": 3, "coding_window_ms": 600000, "cooldown_ms": 10000}
```

The plugin is inactive without this policy. It applies to the primary conversation;
delegated task harnesses retain their existing behavior. Coding can continue at most
three times within its deadline. Permission or question prompts pause continuation;
a rejection or error returns to chat. A harness reload also returns to chat. Remove
other automatic continuation plugins to avoid a second loop.

Modes control attention, not authorization. They do not change tool permissions,
identity, memory, vacation state or approval policy. The current room/terminal
transport does not authenticate owner text cryptographically; its sender labels
must not be treated as a security boundary. Underlying transport authentication
requires a separate fix.

Owner-configured instances may use `kind: "agent"` with any organizational role.
This installs neutral `chat` and `coding` OpenCode profiles on the same model and
with the same permission policy. The role does not grant or revoke tools. Legacy
CTO instances retain their existing profile. A runtime policy `session_name` keeps
the configured display identity on recovery instead of generating a CTO label.

The `agent_profile` tool changes the current agent's display name or icon directly
in conversation mode. It calls `reverie agent profile`, uses the session's own
identity, and grants no role or permission changes.
