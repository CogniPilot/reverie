# SPEC_0001: Owner Operations and Runtime Architecture

## Status

DRAFT

## Summary

Provide one authoritative owner API, a thin GUI client and a Rust runtime.

## Specification

This is the target product contract for configuration, deployment and recovery.
It also records gaps in the current implementation. It does not claim that the
complete workflow described below is available in a released installation.

An owner should install Reverie, connect accounts and configure employees from
the GUI. An explicitly appointed agent should perform the permitted operations
through the documented API. Neither should need a private deployment program,
knowledge of internal JSON files or a sequence reconstructed from chat history.

## Implementation boundaries

| Layer | Preferred language | Responsibility |
| --- | --- | --- |
| GUI and clients | TypeScript | Owner controls, previews and progress using the documented API |
| Core/backend and public API | Rust | Authentication, scoped grants, validation, desired configuration, rollout coordination and durable user-visible status |
| Host runtime | Rust | Engine/process supervision, cgroup enforcement, privileged helpers, native identity checks and durable host operation execution |
| Numerical and model computation | Rust for first-party code | Scientific algorithms and computation adapters behind a computation-specific interface |
| Packaging and host provisioning | Nix and minimal platform glue | Reproducible artifacts, service units and initial host trust installation |

The target is no first-party Python and no Python interpreter in the shipped
service runtime, including numerical/model integrations. Replace Python-dependent
adapters while preserving their capabilities. Track third-party and build-time
dependencies separately: replacing a wrapper does not prove the entire runtime
closure is Python-free. Owner-installed scientific tools inside employee laptops
are outside this implementation-language policy.
Existing JavaScript entry points can migrate to TypeScript when changed. Existing
C/native components need a separate justification before replacement; changing
languages alone is not a reason to discard working native code.

Rust is preferred for the host boundary because these components need precise
process, descriptor and resource lifetimes and low runtime overhead. Measure
startup cost, resident memory and relevant operation latency as components move;
do not present an expected performance improvement as a measured result.

GUI and agent clients call the same application services. The current TypeScript
services remain authoritative until each Rust replacement passes acceptance;
do not create a competing writable backend during the transition. Application
services use a small versioned protocol to the host runtime. Keep its requests
typed and bounded: select a known operation and validated resource identifiers,
never a shell command, interpreter, arbitrary executable or host file to edit.
The website and employee containers do not receive a host engine socket.

The GUI is a thin client of the documented API. It renders forms, previews,
progress and errors and submits explicit owner actions. Authentication,
authorization, validation, capacity accounting, operation transitions and
recovery decisions belong to the backend. A headless client must be able to
perform the same permitted workflow without emulating browser logic.

Publish a versioned, machine-readable API contract from authoritative backend
types. Use structured error codes and actionable messages, typed configuration
revisions, previews and operation results. Expose allowed next actions/blocking
state from the server rather than making every client reinterpret journal phase
names. Form affordances can improve feedback but never become the only validator.
Do not add a generic host-administration execute-command, edit-file or privileged
shell endpoint to make unsupported operations appear available. Existing scoped
interactive terminal APIs remain part of the behavior to preserve.

## Owner experience

Company settings should expose the host resource pool and defaults. An employee's
settings should expose inherited values and explicit overrides for RAM, swap,
CPU, task limits and supported device access. Distinguish these memory concepts:

- A soft limit requests reclaim pressure and can be exceeded when capacity allows.
- A hard ceiling bounds the employee or aggregate pool.
- Admission decides whether the requested allocation fits the enforced budget.
- Swap is a separate finite allowance and capacity constraint.

Changing a soft limit does not remove a hard ceiling or expand an admission pool.
The UI must show requested values separately from observed running values.
Unsupported host capabilities should disable the affected option and explain
the supported remedy before the owner submits a change.

Every disruptive change follows the same product flow:

1. Read the current configuration, revision, running state and host capabilities.
2. Preview the requested change, capacity impact, affected employees and required
   checkpoint/restart. Return a versioned preview with a bounded lifetime.
3. Apply that exact preview under current authorization. Reject changed inputs,
   stale revisions and conflicting operations before effects.
4. Return a durable operation identifier. Report progress and per-employee results
   through the GUI and documented API, including across a website restart.
5. Verify native enforcement and normal employee readiness before reporting the
   change applied. Retain an actionable failure or recovery state otherwise.

A lost response must not trigger another destructive attempt. Reading status
must not replay an apply. Reconciliation observes existing effects and journals;
it does not erase unknown state, clear a fence or fabricate completion. A retry
is permitted only where the operation contract proves it safe.

Install trusted host services through a packaged installer using normal host
administrator authentication. Once installed, routine operations use the same
product path. A required privilege or capability change must identify its exact
installation step in the product, rather than ask an agent to invent a script.
The API never gains permission to run arbitrary privileged commands.

## Authorization and durable state

The owner can appoint an agent for explicit operations and company/employee
scope, with revocation and an audit trail. Carry the authenticated principal and
approved scope through preview, apply and host execution. Guests, role labels,
owner file access and an arbitrary service credential do not imply this grant.
Do not implement agent access by forwarding an owner's browser cookie.

Use the existing profile store for employee desired configuration and its
existing version/CAS rules. Broker configuration is a validated projection,
not an independently editable competing source of truth. Use the existing
operation journal, reservation accounting and session publication checks for
effects. Do not add a parallel journal to bypass their guards. Define retention
and schema migration before changing a persisted format.

Keep identity, accounts, tokens, paths, configuration and receipts outside the
shareable source repository. Persistent instance data must contain data, not an
alternate executable deployment workflow. Historical source archives may be
retained as audit evidence; they are not an installation or recovery interface.

## Current implementation and migration order

The source already has useful boundaries:

- `apps/web/src/resource-replacement-controller.ts` owns employee memory
  preview/apply/result operations, with `ResourceOwnerAuthority` enforcing an
  unrestricted current human owner session. It is an optional path, not a
  general delegated-agent administration API.
- `python/reverie/employee_resource_profiles.py` and
  `laptop_resource_operations.py` provide versioned profiles and durable resource
  operation accounting. Preserve their semantics as implementations migrate.
- Packaged host install/refresh, broker upgrade and resource migration components
  exist, but still require separate operator coordination. Packaging those
  components alone does not deliver the owner workflow above.
- The narrow soft-limit helper now has a packaged Rust replacement with owned
  fixture and independent binary/socket acceptance. Moving that executable does
  not migrate the broker, relax admission or activate a host configuration.

Implement and review the migration in this order:

1. Retire instance-specific operational programs and document their missing
   product capabilities. Preserve instance data, receipts and uncertain operations.
2. Replace the narrow memory-limit helper with Rust behind its existing protocol,
   with custody, identity and effect-uncertain behavior intact.
3. Make the existing owner resource workflow explain unavailable capabilities and
   distinguish saved, running, blocked and recovery-required outcomes.
4. Add reusable host installation/update coordination and scoped agent grants to
   the same application services. Include pool/default/employee settings and a
   coordinated rollout, rather than another private command sequence.
5. Move broker, supervision, storage, lifecycle, memory and numerical integration
   components from Python to Rust; migrate backend application services behind
   their existing API contracts. Remove
   each superseded entry point, dependency and recipe after its replacement passes
   acceptance. Inventory remaining Python by responsibility before declaring the
   language migration complete.

## Acceptance for each replacement

Preserve wire compatibility or provide an explicit versioned transition. Cover
authorization rejection, stale previews, capacity refusal, lost acknowledgements,
process death, restart and retained recovery state where that component owns those
behaviors. Native helpers also need malformed/oversized input, foreign peers,
path/descriptor replacement, PID reuse, deadline and post-write uncertainty cases.
Use an independent adversarial review for authorization and host-effect changes.

Prove packaging includes the replacement and no longer invokes the retired
implementation. Use isolated fixtures first, then a separately authorized native
canary before changing an installed release. Source tests, a successful build and
an API accepting a request are distinct from a verified running deployment.

A feature is complete when a fresh installation can perform it through the
documented GUI/API with status and recovery. Requiring a private script is an
unresolved product gap.

Rust quality rules are owned by [SPEC_0002](SPEC_0002_CODE_COMPLEXITY.md) and
task orchestration by [SPEC_0005](SPEC_0005_DEVELOPMENT_PROCESS.md). The pinned
Nix toolchain provides Cargo, Clippy and rustfmt; Rumoca's compiler-specific
aliases, qualification cfg names and WASM nightly requirements do not apply.
