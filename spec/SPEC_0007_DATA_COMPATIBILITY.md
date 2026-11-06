# SPEC_0007: Existing Company Data Compatibility

## Status

ACCEPTED

## Summary

The Rust transition preserves the owner's existing company, plans and employees.

## Specification

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Read existing accepted data formats during transition | Rust data readers | No forced reset |
| Preserve plans, provider/account references and selected models | Plan services | Keep subscriptions and bindings |
| Preserve permanent employee IDs, roles, settings and permissions | Company services | Existing experts remain themselves |
| Preserve homes, tools, projects, journals, memory and conversation references | Runtime/storage | Continuity |
| Preserve rooms, memberships, messages, DMs, board issues and assignments | Office services | Keep office history |
| Preserve desired-running, vacation and notification choices | Lifecycle services | Respect owner intent |
| Never recreate or rehire employees as a migration shortcut | Migration coordinator | Stable identity |
| Keep each store's single writer explicit during cutover | Owning service | Avoid split truth |
| Preserve canonical bytes, digests, counters and schema identities | Versioned codecs | Cross-language integrity |
| Test snapshot import, round-trip and restore before live migration | Acceptance | Evidence of compatibility |
| Back up consistently through the supported product workflow | Migration service | Recoverable cutover |
| Require explicit reviewed migration for format changes | Schema owner | No silent normalization |
| Keep uncertain journals, reservations, leases and fences | Operation owner | No unsafe replay |
| Prove account, plan and employee inventories before and after | Acceptance | Detect missing data |

Synthetic fixtures prove format behavior; they do not prove the owner's actual
data migrated. An existing-data launch needs a separately authorized consistent
snapshot test and inventory comparison. This spec does not authorize reading
secrets into shared artifacts or copying personal databases into development.
