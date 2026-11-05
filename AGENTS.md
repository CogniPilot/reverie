# Reverie contributor instructions

Read README.md. Use the self-contained native flake environment with
`nix develop` for development. The optional isolated development container is
available through `./scripts/reverie-container exec COMMAND ...`; Podman is not
required for the native runtime. Bootstrap/engine control and private migration
brokers run on the host. Never mount personal instance data into a development
or shared container.

Read the [specification index](spec/README.md) and the owning specs for the
component being changed. DRY and valid-by-construction boundaries are explicit
project requirements; use `cargo xtask` for shared development task orchestration.
Preserve existing plans, experts, identifiers and data through the transition
(SPEC_0007). Add no Python or shell scripts (SPEC_0008); Rust/TypeScript tools
and platform adapters are the portability direction (SPEC_0009). CLI/help,
welcome and notification/memory-hook direction is recorded in SPEC_0010; keep
implementation focused on the Rust port and compatibility before adding features.

All experts are generic AI agents with their own memories. CTO, COO and specialist
titles are organizational roles. Tool permissions and chat/coding mode are separate;
a title grants no authority.
Identity, relationships, model selection, credentials and memory are owner-selected
instance data. Keep them outside this shareable repository.
The target is a Rust core/backend and TypeScript frontend, with no first-party
Python and no Python interpreter in Reverie's shipped service runtime. Implement
new host services, supervision, privileged helpers, resource
enforcement and core backend components in Rust. Existing TypeScript application
services remain the integration boundary until their own bounded migration;
keep GUI/API behavior compatible. Do not introduce first-party Python, including
new numerical or model-computation implementations. Existing Python is migration
debt: replace it in bounded, tested slices before removing an active entry point.
Replace Python-dependent model/runtime adapters as part of the migration.
Inventory third-party and build-time tooling separately; do not claim a runtime
dependency disappeared merely because a first-party wrapper migrated.
Keep existing specialist templates until their consumers have migrated.

Rust crates must inherit workspace lints. Complexity/visibility/unsafe rules are
derived from the owner's Rumoca settings and checked by strict Clippy in CI.
Split large functions; do not suppress complexity lints to make a port pass.
Any necessary unsafe syscall boundary needs a narrow, documented safety argument
and independent adversarial review, never a blanket crate-wide exemption.

Owner operations must use curated product GUI/API workflows backed by the same
application services. The GUI is a thin API client: permission, validation,
capacity, rollout and recovery decisions live behind the API and must also work
for an authorized headless client. An appointed agent requires an explicit scoped grant;
titles, guest access and host access never substitute for that grant. Do not add
instance-specific deployment/recovery scripts or rewrite private runtime files
to work around a missing endpoint. Implement the missing product capability.
Packaged bootstrap tools may establish the host trust boundary once; routine
configuration, updates and recovery belong to the supported product workflow.
See [owner operations](docs/owner-operations.md) for the target architecture,
current gaps and migration acceptance requirements.

Put temporary builds, disposable source checkouts, dependency caches and
regenerable downloads in a task-specific directory under `/tmp`. Check shared
disk capacity before heavy work. Temporary storage may be wiped periodically;
recreate it and verify source revisions, input hashes and required tools at each
run. Use normal project commands and the provided environment defaults.

Keep unique data, unpushed or uncommitted work, cited evidence, results and
one-attempt latches in verified durable workspace, project or private home storage.
Keep configuration, credentials and installed tools outside disposable roots.
Preserve and verify durable source, evidence and results before cleanup, then
remove the task's registered disposable outputs after sealing results. Registration,
a path name or a Git ignore rule alone does not prove a file is disposable.

Reuse owned caches; never move a cache in use. Use the leased task-workspace
helper for cleanup, save a handoff first.

Cleanup must respect live task leases and protect active sockets, runtime state
and credentials. Do not move or delete a live socket by hand. Do not clean another
task's files, shared caches or Nix store paths without specific preservation and
ownership checks.

Run `python3 -m unittest discover -s tests` and
`node --test tests/test_opencode_plugin.mjs` in the flake environment (or the
optional development container). Use explicit file
paths when staging; do not stage instance data, runtime metadata or local receipts.
For Rust changes run `nix develop --command cargo xtask verify`, the canonical
format, strict Clippy and workspace-test gate. Set `CARGO_TARGET_DIR` to
task-specific temporary storage.

The host boundary is controlled outside the container. Container sudo does not grant
host sudo. Optional NixOS account changes need ordinary owner activation; never use
a container engine as a workaround for missing host administrator authentication.

An owner-appointed coordinator with explicit orchestration permission prepares task
context. Delegate only when the user has authorized delegation. Read the
reverie-context skill, select
relevant verified project evidence and lookup hints, and budget for the actual model.
Keep required acceptance checks intact; improve briefs from worker feedback.
