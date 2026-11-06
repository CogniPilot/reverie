# SPEC_0009: Cross-Platform Boundaries

## Status

ACCEPTED

## Summary

Keep portable Rust/TypeScript interfaces independent of operating-system adapters.

## Specification

| Rule | Owner/Where | Brief justification |
| --- | --- | --- |
| Keep core values, codecs and API contracts platform-neutral | Core/contracts | Reusable backend |
| Prefer portable Rust/TypeScript tools over shell orchestration | CLI/tooling | Windows, macOS and Linux |
| Exercise portable components on all supported CI platforms | CI | Verified portability |
| Isolate Linux process, cgroup and descriptor operations | Native host adapters | Honest host requirements |
| Report unsupported capabilities through the API | Capability service | No fake success |
| Show capability limitations through the thin GUI and CLI | Clients | Clear next steps |
| Keep Linux-only dependencies out of portable core crates | Manifests | Compile-time boundary |
| Keep persisted formats portable and versioned | Data codecs | Existing data survives |
| Use platform path/process APIs and explicit argument vectors | Implementation | Correct quoting |
| Test termination, Unicode paths and exit propagation where supported | Tooling tests | Portable behavior |

The initial native broker, cgroup helper and custody store target Linux.
Their existence does not establish Windows/macOS runtime support. Portable core,
contracts and task-runner checks must be reported separately from Linux host
acceptance; skipped native checks never count as passed platform support.
