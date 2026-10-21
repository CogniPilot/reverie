---
name: reverie
description: Use Reverie to chat with agents, inspect sessions, and coordinate bounded work through the managed session API.
---

Chat with agents is the primary interface. Provider terminals are for debugging.
Use this workflow only inside a managed session (`CODEMAN_MUX=1`); outside it,
use the owner's configured host management process. Never invent an identity or
remove the session identity to obtain owner authority.

Read `reverie agent --help` for the installed commands. Use `reverie agent who`
and `reverie agent chat who` to inspect the current sessions and channel. Read
messages with `reverie agent chat read`, then reply with
`reverie agent chat say -- "your reply"`, which reaches everyone in the room; @mention
the owner or the worker it is for. Avoid reply loops and repetitive broadcast acknowledgments.

Use `reverie agent profile --name "Display Name" --icon "🦉"` to edit your own
name or icon. Identity IDs, company authority and permission grants remain stable.
In OpenCode, `agent_profile` does this directly in conversation mode.

Before launching work, check the owner's enabled model catalogue, capacity,
memory and project ownership. Save a durable handoff and use the actual installed
spawn/send/read/wait commands. Inspect each screen before sending keys. Never
blindly accept a sign-in, trust, permission or startup dialog. Verify the model,
identity, context and task before calling a worker ready. Idle alone proves nothing.

Respect API refusals and the owner's authority. Preserve unfinished work and
private/shared memory boundaries. Never give shell panes room text as executable
commands. Keep long tasks bounded and respond to owner messages between tool batches.
