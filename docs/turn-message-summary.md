# Automatic pending-message context

The server builds one read-only summary per expert at `GET /api/chatrooms/turn-summary`.
The exact authenticated agent caller is the only target. It scans current joined rooms
and DMs, with owner and DM membership checks; it excludes deleted messages, the
expert's own messages and exact answered messages. Unread identities, exact queued
or uncertain-delivery gaps and tracked unanswered owner requests can appear.

Current phone mode filters messages before any excerpt is rendered, using the existing
server phone policy:

| Mode | Eligible pending traffic |
| --- | --- |
| Ring | Addressed room traffic and DMs visible to this expert |
| Vibrate | Owner messages and unique direct peer mentions |
| Silent | Owner's unique direct mention or `@everyone` only |

Expired quiet leases fall back to ring. A human/guest label never becomes owner authority.
Direct owner messages, DMs and mentions rank ahead of ordinary room traffic. The
snapshot contains at most six records, each excerpt at most 180 characters, with a
3,000-character total text limit and an omitted count. No summarizer model is called.
Records quote untrusted text and retain message/room IDs for a specific follow-up
only when necessary. Summary generation never marks anything read, acknowledges
uncertain delivery, triggers a turn, changes phone settings or resends a message.

## Harness adapters

- **Claude Code:** managed `SessionStart`, `UserPromptSubmit` and `PostToolUse` hooks
  inject `hookSpecificOutput.additionalContext` automatically.
- **Codex:** the same events are registered in the managed workspace's supported
  `.codex/hooks.json`, preserving unrelated hooks. Codex's ordinary project/hook trust
  requirements still apply; Reverie does not silently trust hooks or alter approval
  policy. Startup and respawn install the handlers for local managed workspaces,
  including worker-backed shared workspaces; remote and explicit Docker attachments
  are not automatically configured.
- **Reverie Admin Harness:** immediately before each actual model request (including
  search/retry and terminal turns), the existing scoped CLI fetches a fresh snapshot.
  It replaces ephemeral context rather than appending to saved history, and fits the
  remaining prompt budget. Unavailable reads are explicitly unknown, not empty.

Codex `UserPromptSubmit` is a pre-submission hook, not a callback before every internal
model request. `PostToolUse` supplies updated context to tool-driven continuations.
Hook-enabled Codex versions and normal trust admission are required; unsupported
clients must not be described as automatically covered. Official hook reference:
https://learn.chatgpt.com/docs/hooks .

Both CLI hook adapters have short deadlines and nonblocking failure behavior. A
private session-local digest (no message content) suppresses identical tool-continuation
summaries; a fresh user prompt gets fresh context, and cleared pending state is signaled
once. Failures do not clear that digest or turn unknown delivery into success.

`reverie agent chat summary --json` exposes the same snapshot for adapters; ordinary
experts do not need to poll rooms or manually call it. `--hook-event` formats context
for supported native hook events. Neither form consumes the server's pending state.

This source change requires installation of the updated website/CLI and a normal
managed hook refresh before it is live; source tests are not live rollout acceptance.
