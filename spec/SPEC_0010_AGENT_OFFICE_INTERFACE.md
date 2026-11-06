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

This is product direction, not a request to expand implementation during the
Rust port. Preserve existing briefing, message delivery and memory behavior
through the port first. Future hook work must specify delivery, deduplication,
privacy, context budgets and acknowledgement semantics, with tests proving it
does not flood context or silently mark work complete.

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
