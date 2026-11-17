# SPEC_0010: Agent Office Interface and Memory

## Status

DRAFT

## Summary

Give agents concise office awareness through a discoverable CLI, welcome briefs and scoped hooks.

## Specification

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Model rooms, DMs, notifications, laptops, phones, boards and issues coherently | Office API | Human office behavior |
| Keep one authoritative API for GUI, CLI and hooks | Application services | No reinvented control paths |
| Build the Rust public CLI with Clap | CLI | Consistent exceptional help |
| Provide task-oriented discovery, examples, permissions and troubleshooting | CLI help | Useful to humans and agents |
| Document existing commands before adding competing tools | CLI/docs | Reuse what's available |
| Make machine-readable output and errors stable and documented | CLI | Reliable automation |
| Give every joining/restarted agent a compact current welcome brief | Bootstrap | Know identity and surroundings |
| Include identity, role, current work, grants, rooms and memory entry points | Welcome brief | Immediate orientation |
| Generate the welcome and identity brief from the same employee record | Briefing service | No conflicting identities |
| Let owners curate shared orientation through the GUI/API | Office configuration | Reusable onboarding |
| Deliver orientation automatically before the employee's first task | Harness adapters | Discovery cannot depend on remembering a skill |
| Refresh current orientation on resume without repeating public welcome posts | Session bootstrap | Continuity without channel noise |
| Preserve stable employee memory across harness/model/session changes | Memory services | Employee continuity |
| Keep full memory searchable; retrieve relevant portions | Context assembly | No full-history dump |
| Include a bounded continuity summary and memory lookup instructions in briefs | Briefing service | Know what persists and how to recall it |
| Keep memory ownership tied to employee identity, not a transient worker | Memory services | Restarts retain the same employee |
| Deliver bounded unread/mention/DM/task summaries at appropriate hooks | Notification hooks | Notice relevant changes |
| Respect ring/vibrate/silent, focus and owner policy | Notification service | Appropriate interruptions |
| Keep unread state available when interruptions are suppressed | Inbox service | No lost updates |
| Preserve provenance, scope and timestamps on inserted context | Context contracts | Distinguish data from authority |
| Explore keyword-triggered memory recall with budgets and deduplication | Memory hooks | Relevant ideas at the right time |
| Avoid broad MCP catalogs when CLI discovery provides the capability | Agent integration | Lower context overhead |
| Make a short orientation skill optional when startup context suffices | Agent bootstrap | Minimal duplication |
| Reserve specialized skills for workflow guidance absent from CLI help | Skills | One documentation owner |
| Never treat a notification, recalled memory or role label as authority | All consumers | Safe execution |

The owner has requested a first-class Rust command-line frontend for both humans
and agents, including human notifications without opening the website. The
acceptance contract below is required work, not installed-release evidence.
Preserve existing briefing, message delivery and memory behavior through the
port. Hook work must specify delivery, deduplication, privacy, context budgets
and acknowledgement semantics; tests must prove it does not flood context or
silently mark work complete.

## Production command-line frontend

The Rust API owns authorization, resolution, operation state and notification
semantics. The Rust CLI, optional terminal chat view and TypeScript browser are
clients of that API. A human does not need the browser to discover channels,
read/reply, manage permitted company operations or recover an original operation.
A raw HTTP `call` command is a diagnostic escape hatch, not frontend parity.

The following syntax illustrates the intended interface; it does not assert
that these exact commands are implemented:

```text
reverie whoami
reverie status
reverie inbox
reverie channels list --all
reverie chat read microduck --unread
reverie employees show Ada
reverie employees restart Burt --wait
reverie plans move self --to "Claude CogniPilot"
reverie operations watch --last
reverie watch
```

| Contract | Acceptance |
| --- | --- |
| Names and `self` are normal selectors | Resolve within the authenticated company and visible objects. Full IDs remain available for precise automation; routine operations do not require callers to copy session IDs, generations or digests. |
| Ambiguity is explicit | List authorized candidates with useful names. Never choose the first partial/fuzzy match for a mutation. Interactive selection is optional and requires a terminal. |
| Selection is not authority | Resolve and retain the exact identity/binding, then recheck it at the API effect boundary. Rename, generation change, permission revocation or account change must not redirect an operation. |
| Context is inspectable | Show the authenticated human/employee, server, company and current room. A role flag, title or caller-supplied employee name does not impersonate another principal. |
| Defaults are predictable | Inherit an agent's genuine current identity. Use a room default only when the selected context identifies one room; ambiguous bundled prompts require a choice. |
| Discovery is useful | Provide command groups, task examples, shell completion, permission requirements, expected outcomes and related commands from one command catalogue. Help and completion perform no business mutation. |
| Human output is readable | Show names, local timestamps with timezone, status, blockers and a concrete next command. Support narrow terminals, plain output, no color and piped input without requiring a pager. |
| Machine output is stable | Provide versioned JSON, structured error codes and documented exit codes. Keep progress/diagnostics off JSON stdout. Agents and non-TTY invocations never encounter hidden prompts. |
| Original operations are easy to follow | Generate one request ID before dispatch and expose a scoped operation handle before waiting. Lost replies preserve the original handle; watch/reconnect inspect it without resubmitting the action. |
| Last-operation shortcuts are scoped | Bind `--last` to the current authenticated context and client; another employee or concurrent company's operation cannot become its target. |
| Website parity is measurable | Track every permitted browser action against its Rust API operation, semantic CLI command, help example and executable CI case. Unsupported functionality stays visibly pending. |

Existing name-based room selection, public-channel discovery, pending notices,
mentions, delivery status and command help are migration inputs. Preserve and
consolidate them instead of introducing a competing notification or command model.
An agent may discover its joined and otherwise discoverable channels; `--all`
does not expose private rooms or messages outside its grants.

## Shared notifications for humans and agents

One Rust notification service records attention durably before publishing it.
Notifications belong to the authenticated human or permanent employee, not a
disposable worker session. Plan moves and reconnects preserve the inbox and its
source references. All event reads, replay and acknowledgements enforce current
membership and permissions.

| Fact | Meaning |
| --- | --- |
| Pending | The server retained attention for this recipient. |
| Delivered | A particular authorized client received the notification. |
| Read | The recipient explicitly read its source message. |
| Handled | The recipient explicitly disposed of the attention request. |
| Work completed | A separate task/Board action; no notification acknowledgement implies it. |

- Give each event a stable ID and bounded replay cursor. Per-client delivery
  cursors must not silently advance the recipient's read/handled state.
- Provide an inbox summary by channel and sender that distinguishes unread,
  mentions, requests awaiting a reply, queued delivery and held delivery.
  Explain holds and link to the exact original recovery/status operation.
- Agent hooks show bounded summaries at supported safe lifecycle points.
  Busy agents retain their notices for the next safe point. Repeated hooks
  coalesce summaries without losing the underlying events or inventing ACKs.
- A human terminal chat view shows a persistent unread/mentions indicator and
  an accessible inbox. Preserve drafts and keyboard focus during notifications.
- An explicit foreground `watch` client supports shell users. It reconnects
  using its original cursor, visibly reports a disconnected stream and requires
  no additional host application service.
- Apply the same API-owned notification preferences to humans and agents:
  mentions/replies, urgency, quiet periods and optional terminal sound. Keep
  pending attention available when presentation is suppressed.
- Explicitly configured external hooks receive bounded typed event data on
  stdin, use an executable/argument vector rather than a message-built shell
  command, and have execution limits. Hook success establishes delivery only.
  A failed/unknown hook result never marks attention handled or work complete.
- Render untrusted message/name text safely in terminals. It must not inject
  control sequences, commands, identities or notification acknowledgements.

## Required CLI and notification acceptance

CI must run compiled Rust commands against the real Rust HTTP service, with
the GUI disabled and no Node/Python fallback. Pure parser or mocked transport
tests supplement this gate; they cannot qualify native employee lifecycle.

| Scenario | Required evidence |
| --- | --- |
| Human onboarding | Authenticate, inspect context, find channels, read/reply and inspect permitted employee operations through semantic commands and built-in help. |
| Agent onboarding | Genuine employee credentials, `self`, current grants, room discovery and bounded pending attention; no owner-role DTO or implicit impersonation. |
| Name resolution | Exact names, spaces/non-ASCII names, duplicate names, rename/rebind races, revoked access and explicit-ID fallback; zero wrong-target effects. |
| Frontend equivalence | GUI/API/CLI operations yield the same authorization, state transition and original-operation behavior. |
| Reliable notifications | Offline recipient, duplicate event/hook, dropped stream, cursor replay, client/server restart, expired credentials, revoked room access and employee plan move. |
| Attention semantics | Inspection, delivery, reading and handling remain distinct; none implicitly completes Board work or acknowledges an unrelated source message. |
| Human terminal behavior | Resizing, narrow display, draft preservation, focus, quiet mode, reconnect status, cancellation, clean exit and no background/piped-output corruption. |
| Automation behavior | Stable JSON/exit codes, bounded pagination/watch, no TTY prompts, structured ambiguity/permission errors and original-operation inspection after a lost mutation reply. |

Skill loading differs by harness. Available metadata may occupy initial context;
full instructions may load on demand. Do not assume installation alone provides
orientation, complete memory ingestion or automatic delivery in every harness.

The target welcome is a product briefing, automatically supplied through each
harness adapter. It identifies the employee, company, responsibilities, current
assignments and authorized capabilities; points to CLI help, relevant rooms and
the employee's persistent memory; and explains how to retrieve and record memory.
Shared orientation and employee-specific facts have separate ownership, with one
canonical briefing service composing both. Do not duplicate the handbook or all
command help in every prompt. Skills remain optional workflow guidance.

Persistent employee memory may exceed the active context window. Preserve
the complete authorized memory store while selecting only a bounded continuity
summary and relevant recall results for a particular session. A provider/model
change, laptop replacement or resumed session must retain employee identity and
memory under [SPEC_0007](SPEC_0007_DATA_COMPATIBILITY.md). Before implementation,
define context budgets, refresh and
delivery receipts, stale-brief handling and failure behavior. Acceptance checks
must cover first join, restart, provider change, duplicate delivery and memory
isolation between employees. This direction does not assert these guarantees
already exist in the current runtime.
