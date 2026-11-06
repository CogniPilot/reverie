# Linux native adapters

`memory_configuration::MemoryConfiguration` captures named settings once in
the actual calling namespace. Explicit instance paths use the shared Python
path resolver and fixed NSS home lookup; relative data is placed beside the
resolved config and never falls back to personal memory. Capture performs no
directory creation, DB initialization, model probe or profile writing. Named
directory creation and the existing one-probe embedding selection are explicit
startup methods. Model/dimensions/document-prefix/query-prefix remain separate.

`memory_profile::ProfileFile` can target only the captured profile.md. It
preserves an existing owner profile; new derived data uses an exclusive private
temporary, held directory/writer descriptors, exact prepared/readback stamps,
no-replace rename, directory fsync and checked closes. All leaf operations are
relative to the held directory. Swapped/edited/link/mode-drifted preparation is
refused without deleting foreign data. A failure after attempting publication
reports uncertainty, never rollback. This is an observation in an installed
namespace, not protection against arbitrary same-UID namespace mutation or an
owner grant. No arbitrary destination/file editor is introduced.

This crate observes installed artifact and current storage identity facts for
native broker composition. It creates no service, editor, deployment command,
owner grant, execution permit or writable configuration path. The separately
named derived-memory-profile writer below is an explicit startup effect.

`worker_launch` resolves selected account namespace paths and observes the
employee hostname metadata in the source order. It reads no credential contents,
retains no directory custody and creates no mounts. Containment compares the
shared resolver's Python path text, including surrogate provenance.

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
and purpose-specific private modules under `native/`.
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

`reservation_kernel` provides fixed `/proc` and `/sys/fs/cgroup` observations
for the application's reservation observer. It qualifies the whole host
hierarchy, brackets namespace and PID metadata, reads every applicable finite
ancestor limit, and checks source/container directory identities with O_PATH.
Full mount-row data and same-device coordinates remain distinct from device
identity alone. Storage observations retain original Python path text beside
native bytes and compare it with the existing storage resolver's paths.
Descriptors receive explicit checked close handling on both success and failure.
The adapter cannot grant admission, retain a storage lease, start a container or
turn a snapshot into a native effect permit. Its private owned-source test seam
does not introduce a production root/path override.

`reservation_control` observes the exact reservation control directory/file
layout and owns a real nonblocking admission flock until explicit checked close.
The stored directory iteration order is retained; root-owned sticky ancestors
remain distinct from final owner-only mode0700 directories. Marker contents and
stored inode data alone grant no admission. `capture_current_image` independently
binds the loader-selected file with the original bounded strict-byte reader,
parse/close/image-comparison order and final named-file stamp. Ancestor aliases
are permitted there while leaf aliases and multiply-linked files refuse; this
does not relax the separate control, OPS or metadata traversal policies. The
application still owns pending-transition, full census and terminal fences.

The existing kernel custody scan also accepts `CustodyPaths` DATA from actual
installed service owners. The application-private target selection currently
supports canonical control metadata and the actual captured current-image file;
it retains the original Source, complete before/after census, mount table,
deadline and context origin. Declaration parsing is not a custody/effect grant,
and unported preparation/transport/host-job owners are not fabricated as selectors.

## Configured embeddings

`embeddings` implements the configured HTTP(S) llama embedding backend and the
existing single startup probe followed by the genuine hashed-backend fallback.
After selection, later provider failures propagate. Neither response data nor
fallback grants model-selection, persistence or owner authority. Existing Python
entrypoints remain selected until coordinated service migration.

Hyper owns HTTP framing and rustls with its ring provider and platform verifier
owns TLS. Tokio supplies native I/O. The purpose adapter preserves raw request
targets, JSON bytes, per-blocking-I/O timeout behavior, unbounded response bodies,
urllib redirect counts/method changes and no POST retries/replays. Interim status
and large accepted response-head cases have actual Python witnesses; this is not
a claim that every malformed HTTP parser diagnostic matches http.client.
Lossless model/prefix/query codepoints remain distinct from SQL-storable text.
Configured URL text also retains codepoints through suffixing and Request's
strip/unwrap phase: discarded surrogate fragments are accepted, while actual
non-scalar network text refuses before connecting. Scalar constructors remain
available and do not normalize the request target.

Host headers retain urllib's Latin-1 behavior. DNS/SNI independently use its
IDNA2003/nameprep rules, using the maintained `idna` crate's Punycode primitive
and frozen Unicode3.2 facts. Unicode normalization is adapted to those facts;
modern UTS46 conversion would change accepted routes. The dependency inventory
still includes idna's transitive ICU dependencies and SQLite/ring native code;
the port does not imply a dependency-free runtime.

Proxy routing, environment precedence, CONNECT, redirects and TLS are qualified
with synthetic local servers and task-owned certificates. One reviewed security
fix intentionally differs from urllib: Proxy-Authorization stays with the
selected proxy and never follows a bypassed origin or another proxy's route.
It is removed before inner CONNECT-origin requests. No provider, private endpoint
or billing API is used by qualification. Incidental non-HTTP urllib transports
(for example file/data/FTP origins) remain unproven; their configured use must be
inventoried through supported settings before cutover, then covered by named
adapters or an explicit reviewed compatibility decision. No Python fallback is
hidden behind unsupported transports.
