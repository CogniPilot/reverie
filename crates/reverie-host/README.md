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
by production observation. Unsafe Linux calls are confined to `src/native.rs`
and its private `native/lease.rs` descriptor-walk module.
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

The existing Python broker remains selected. The task-perf artifact is now built
by the separate Rust build-only policy-artifacts package, with filtered actual
crate/dependency inputs. The separate Docker base-profile Python producer and
other build-time tooling remain migration debt. Neither this library nor its
tests claim a consumer cutover, activation, a live syscall canary or the complete
Python-free backend has finished.

`lease_policy::project_lease` consumes a captured `LeaseConfig` and session,
obtaining the company path and UID comparison only from that same configuration.
The enabled option's company read preserves its distinct legacy policy:
descriptor-relative no-follow readable ancestors, one-MiB bound, configured UID,
single-link regular type and stable observations, without adding the employee
metadata reader's write-mode gate. The selected current EID/SID lookup adds no
owner, generation, retired-registry, vacation or unrelated-deduplication rules.
Absent/null options preserve identity; foreign SIDs never read the peer artifact.

For a selected SID, `observe_peer_artifact` checks the existing owner-selected
peerBinary setting, canonical root-owned Nix output custody (including the
sticky-store exception), a regular executable with no write bits, a four-MiB
bound, stable descriptor/name metadata, native static ELF64 headers and SHA-256.
Stable Nix hardlinks remain allowed. The returned artifact hash/inode/header
facts accompany exactly one readonly single-file mount in the projected data.
No public endpoint, arbitrary-file service or new artifact-path configuration
knob is introduced; this preserves the existing immutable owner setting.

The lease observer never invokes the peer, serves a socket, acquires a lease,
changes capabilities, mounts an artifact or proves its guest/kernel identity.
Those original `peer_artifact.mounted` and acceptance-process checks remain
separate required work. The native source-package integration test is explicitly
ignored by default and requires a separately built immutable artifact plus an
independent legacy hash/inode receipt; running it qualifies readonly source
observation only, not execution or mounted proof.
## Worker mount source observations

`worker_mounts::observe_mount_sources` borrows the captured `WorkerEnvelope` and
performs the existing strict native source resolution, lexical control-root
exclusions, and shared-attachment real-directory/alias checks. It preserves
accepted source files and symlink aliases; attachments specifically require a
real directory. Both lexical and resolved overlap checks use the same pure
POSIX path owner. The native path conversion owner preserves arbitrary POSIX
bytes through Python-compatible UTF-8 surrogateescape without replacement.
The strict resolver separately preserves Python string provenance of untouched
components and decodes only symlink targets. Native byte paths cannot recover
that distinction. Keep `resolved_path_text()` for the legacy lexical comparisons;
`resolved_source()` provides native lookup bytes and is not an equivalent text
view. Resolution follows the flake Python 3.13 strict realpath behavior,
including non-directory intermediates, cycles and long acyclic link chains.

The observations are protected configuration data, not a public API response,
mount permit, pinned inode or completed whole-worker validator. No descriptor
remains pinned. Preserve the original source spelling for hashes/engine args,
and reobserve under the actual admitted native-effect workflow. The existing
validator's lexical interpretation of weak control paths (including double
slash anchors and '..') remains explicit; these observations alone cannot
establish control-root custody. No new source path policy or count limit is
introduced in this compatibility unit.

Fifty-eight actual Python full-validator filesystem cases cover regular and
symlink sources, missing sources, control roots, workspace attachments and
resolved/lexical aliases. Twenty specifically discriminate resolved string
provenance, relative versus absolute symlink targets, strict file suffixes,
cycles and a 100-link acyclic chain. Another 136 actual Python filesystem-byte vectors
qualify the shared surrogateescape decoder/encoder. Only owned synthetic files
are created. No engine call, mount, real socket or company instance data is used.

`rootless` completes the readonly rootless profile, account and image-policy
service over captured data. Production sub-ID reads are fixed to `/etc/subuid`
and `/etc/subgid` with real passwd/UID lookup; no public source override exists.
It returns original security/runtime argument data after actual profile/hash,
applicable syscall, fixed-perf and subordinate-grant qualification. Engine image
inspection remains input data, and each effect consumer must freshly bind it
and requalify before use. No engine call, capability change or selected product
consumer is added. The [compatibility audit](../reverie-contracts/src/rootless/README.md)
records accepted Python quirks, observation hardening and remaining boundaries.
