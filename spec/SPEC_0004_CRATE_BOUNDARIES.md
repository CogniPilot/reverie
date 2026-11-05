# SPEC_0004: Crate Boundaries and Single Ownership

## Status

ACCEPTED

## Summary

Use Rumoca-style crates as dependency and collaboration guardrails.

## Specification

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Put Rust crates under crates/reverie-*; keep crates/xtask | Workspace | Predictable layout |
| List members explicitly and keep one lockfile | Root manifest | Reviewed build graph |
| Centralize shared dependency versions in workspace dependencies | Root manifest | No version drift |
| Give each policy, store and algorithm one owner | Owning crate | DRY |
| Direct dependencies toward lower-level contracts without cycles | Manifests | Compiler-enforced boundaries |
| Keep domain values independent of HTTP, engines and GUI | Domain crates | Portable invariants |
| Separate wire contracts from effect authority | Contract boundary | Data is not permission |
| Host adapters enforce effects; application services own workflows | Runtime/API crates | Clear responsibilities |
| GUI and agent clients use the same API | API boundary | No hidden client workflow |
| Keep xtask independent of product runtime crates | crates/xtask | Small task runner |
| Create crates for real behavior with tests | Workspace | No empty scaffolding |
| Read dependencies before editing a crate | Contributors | Bounded context |

Adapted from Rumoca SPEC_0029. Compiler/parser/IR rules do not carry over.
Planned owners include reverie-core, reverie-contracts, application/API services,
host adapters and the public CLI; create them when real implementations arrive.
Concrete initial crates are the soft-limit helper, laptop tooling and xtask.
The API/backend migration remains in progress.
