# Read-only Linux host observations

This crate observes installed artifact and current storage identity facts for
native broker composition. It creates no service, editor, deployment command,
owner grant, execution permit or writable configuration path.

`task_perf::observe_installed_task_perf` reads only the manifest bound at compile
time by `REVERIE_FIXED_TASK_PERF_MANIFEST`. The trusted native package should
inherit [the fixed Nix bindings](../../nix/host-artifact-bindings.nix), which derive
that path from the existing fixed producer and Docker base. No runtime environment,
config, request or public API parameter selects an artifact pathname. Without
the binding the observer refuses; it never falls back to another file or Python.
This library is not yet selected by a production native broker.

The perf observer keeps its original Nix purpose policy: canonical regular files,
root or real-current-UID ownership, no group/world write bits, at most 65536 bytes,
and matching descriptor-before/after and final named stamps. Owner write bits
and stable hardlinks remain accepted. These rules do not replace the distinct
private profile mode 0600 or employee metadata custody policies. Linux uname
supplies the actual system/machine; only x86_64-linux and aarch64-linux qualify.

Reads remain descriptor-pinned through the final identity checks. Close errors
are checked once and both primary and finalizer failures are retained. No file,
symlink, directory, socket or temporary is created, removed, repaired or changed
by production observation. Unsafe Linux calls are confined to `src/native.rs`.
Test ports and fault injection are private and compiled only into owning tests.

`project_task_perf` accepts a captured perf configuration, storage identity
configuration from that same worker domain, and a session. An empty policy map
does not read company or artifact data. Unselected current employees do not read
artifacts. A selected employee is observed through the actual storage resolver
before and after artifact validation; ownership or generation drift refuses the
candidate. OFF/vacation/start eligibility remains independent. The result is
projected data, never owner authority, readiness or proof of a kernel effect.

`recognized_task_perf` checks only the selected marker/fixed profile relationship.
The consuming broker must still enforce complete rootless Docker configuration,
image/capability restrictions, current authorization and kernel permissions.
Observation never calls perf_event_open, an engine or a process control API.

Core owns checked task-v1 maps and the exact signed-int CPU=-1 filter. Contracts
owns the manifest schema, whole-base derivative, Python-compatible JSON equality,
exact raw hashes and lossless projection. The observer reuses those owners and
the existing current-employee resolver instead of defining a second policy model.

`device_policy` composes the checked GPU and soft-memory policy projections with
the same captured worker domain's actual storage identity configuration. Derived
GPU arguments require a current employee, observed before and after projection;
employee, owner or generation changes refuse the candidate. Explicit session GPU
priority and empty employee maps do not read registry metadata. Historical or
retired storage never supplies a derived GPU grant. OFF/vacation and other start
eligibility checks remain separate.

Memory projection deliberately selects by storage identity, so historical and
retired employee storage remains eligible. It checks the resolved storage paths
again before returning; generation changes alone do not change this storage
binding. A selected high threshold requires an actual checked effective
`ResourcePolicy` and the matching finite integer RAM ceiling in the projected
resources. Unselected and swap-only policies do not inspect that ceiling. The
`project_effective_memory_resources` convenience entrypoint derives the checked
policy from the six effective resource fields only after selecting a high
threshold, within the same storage observation bracket. Already checked staging
callers can supply their policy directly to `project_memory_resources`. The
resource-config entrypoints preserve the existing inactive-map and truthiness
rules; direct feature entrypoints retain their stricter feature validation.

These APIs return configuration and fixed engine-argument data. They do not
admit a shared swap budget, inspect or modify cgroups, start an engine, configure
a running container, prove an effect, or authorize an operation. The consuming
broker must still retain its supported admission and execution guards. This
cohort does not replace `worker_memory.check_swap_budget`, `configure_started`,
soft-limit requests or running-kernel verification.

The existing Python broker and artifact producer remain selected. Migrating the
build-time first-party Python producer is **required remaining work**, preserving
its filtered policy/builder/base/toolchain identity so unrelated workspace edits
do not churn installed profile paths. Neither this library nor its tests claim
that producer retirement, a consumer cutover, activation, a live syscall canary
or the complete Python-free backend has finished.
