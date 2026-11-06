# Reverie application services

`worker_validation::{validate_captured,load_owner_config}` composes the complete
ordered worker validator and its compatible owner-file loader. The returned
snapshot retains original data and readonly observations; no native mount,
start, owner or publication authority is created. Its
[ownership/compatibility audit](src/worker_validation/README.md) inventories the
still-Python runtime consumers and separate startup/effect obligations.

This crate owns workflows across the core, contracts, store and native host
adapters. HTTP/CLI transports should call these services after authenticating
and admitting the operation; they should not reproduce workflow decisions.
The current service is Linux-native because its backing stores and observations
are Linux implementations. Platform-neutral policy remains in the lower crates.

`resource_staging::stage_config` ports the existing profile staging workflow.
It retains the real `profiles.lock` and original profile descriptor through
revision/version/binding checks, resource-map staging, native GPU/perf/memory/
lease projection and all legacy hashes. It checks read finalization on success
and failure and retains both errors if projection and finalization fail. The
borrowed store must also be closed and its result checked by the owner before
any terminal/native operation acknowledgement.

`effective_config` composes the existing GPU, resource, perf, memory and lease
data transformations. Native storage paths come from the same captured worker
configuration. Historical storage can select memory policy but cannot confer a
current employee's GPU/perf grant. Explicit legacy GPU SID priority and inactive
features do not require identity paths or fixed artifact availability. Full
worker schema validation and caller authorization remain outside this service.

Candidates and hashes describe protected configuration data. They grant no
owner permission, native effect permit, start eligibility, reservation or
publication authority. Neither method writes broker configuration, reloads a
worker, invokes an engine or selects a second backend. Production broker
selection and its admission/effect/reconciliation workflow remain migration work.

Tests bind six actual Python profile-stage results to exact candidate/effective
bytes and three separate digests using the real private store. Additional actual
Python native-filesystem vectors cover current GPU/memory and historical memory
without current GPU/perf. Refusal tests exercise stale profiles, custody changes
during resolution, dual failures and inactive/legacy feature bypasses. All
fixtures use owned synthetic files, never company instance data.

`reservation_observer::NativeObserver` owns the complete read-side reservation
observation workflow over one persistent supervised engine client and the fixed
Linux kernel adapter. A captured context binds all censuses and row handles to
the same configuration snapshot. Public contract rows cannot be submitted as
native observation handles. This is an internal broker service, without a wire
constructor, request-selected proc/cgroup roots or arbitrary engine arguments.
The [observation audit](src/reservation_observer/README.md) maps each legacy
method and its remaining effect/admission obligations.

Captured observation contexts retain the same persistent engine/kernel source
and shared cancellation after the installing handle is moved or dropped. Census
data may be compared across contexts using Python structural equality, but row
handles remain bound to their original context and cannot be rebound by equal
data. The owner loader retains its optional source path only after full
validation; embedded captured configurations retain no file binding. The actual
reader and recorded path share Python's lexical `Path` spelling, including
relative and '..' components and the exact double-slash anchor. This is source
data, not configuration custody or a permission grant.

`tests/installed_policy.rs` is a separate, ignored qualification for all four
selected features together: current-employee GPU, the real fixed perf
derivative, memory and the immutable lease peer mount data. Its Python oracle
used the actual existing identity and artifact verifiers without stubs. Only
`worker_perf.__file__` was bound to the installed manifest's sibling location,
matching the existing package convention. The portable fixture substitutes the
owned root, UID and immutable artifact paths; exact output and policy bytes and
both hashes must match. Artifact hashes and the qualified system remain explicit
fixture requirements, so a different build needs its own reviewed oracle.

The test is ignored by the ordinary gate because it requires separately built
real artifacts. Both artifact paths are compile-time bindings; the peer binding
exists only in this test. With `PERF_MANIFEST` and `PEER_BINARY` set to the
qualified immutable outputs and `TMPDIR` set to a short, owned temporary path:

```console
nix develop --command env TMPDIR="$TMPDIR" \
  REVERIE_FIXED_TASK_PERF_MANIFEST="$PERF_MANIFEST" \
  REVERIE_QUALIFICATION_PEER_BINARY="$PEER_BINARY" \
  cargo test --locked -p reverie-application --test installed_policy \
  -- --ignored --exact selected_gpu_perf_memory_and_lease_match_actual_python_bytes_and_hashes
```

This only reads the immutable sources and owned synthetic company metadata.
It never executes the peer, invokes an engine, creates a socket, mounts anything,
changes a profile or qualifies an owner permission or live kernel effect.

`worker_launch` prepares checked request/create/tmux/account data with actual
readonly account/hostname observations. See its [boundary and consumer
inventory](src/worker_launch/README.md); plans are never admission/effect permits.

`reservation_gate` now composes actual ordinary admission, canonical lookup and
the complete read-side reservation observation over these same owners. Its
[checkpoint audit](src/reservation_gate/README.md) records source phases, real
lock/finalizer handling, compatible hashes and still-required claim/effect owners.
It is inactive and does not select a broker or grant a launch/completion permit.

`InstallingBroker` owns a current validated configuration snapshot distinct from
each retained preparation's original source. Resource reload performs the real
owner-file load/full validation, active-operation fences and ordered registered
laptop inspection before an internal snapshot CAS updates that same observer
origin. Its registry has no public data-created registration constructor; actual
supervised launch/recovery producers remain required before it can own laptops.
An empty initial registry never establishes ownership of global engine inventory.

`RetainedPreparation::commit_configuration` stages and fully validates its own
candidate, retains the actual owner-file/directory binding, publishes durable
attempt/before evidence and an exclusive temporary, then performs the adjacent
original-file stamp check and rename/fsync/checked close. It reloads the same
installing state, rechecks the actual current file and live claim, and only then
records `PREPARED_CONFIG_ONLY_SOURCE_UNCHANGED`. After an attempted failure it
retains evidence and refuses replay; it never rolls back a possible publication.
This implements policy-file preparation, not an engine start, source stop,
capacity release, API authorization or a selected product workflow.

`project_memory::ProjectMemory` preserves the separate lowercase project
namespace, default lexical model, six-result lookup, source/fact validation and
original 8,000/1,000-codepoint limits. Its scalar convenience methods share
lossless query/fact/source input paths. `memory_import::migrate_history` preserves
the existing user/assistant pairing, idle marker, file-mtime-derived timestamps,
per-episode commits and final one-time state marker. It does not reset a database
or silently re-embed records. Trusted service installation selects these paths;
the library is not an arbitrary-file operator API or a selected product route.

`memory_startup::StartedMemory` is an explicit installed-instance workflow:
selected embedding probe/re-embedding, atomic selected seeds plus initial-self
CAS, one atomic new history batch/marker, and deterministic missing-profile
publication. It preserves IDs/BLOBs, existing self documents and owner profiles.
Unlike the old per-episode importer, an unmarked historical partial import is
an explicit ambiguity refusal; it is never reset or imported a second time.
Seed membership uses the actual normalized persisted text and includes this
new batch, avoiding the old duplicate insertion on repeated/whitespace seeds.
These are intentional curated startup corrections, qualified separately from
the retained legacy helper.

`memory_recall::MemoryRecall` receives the already selected model and opens only
an existing READ_ONLY store. It never runs startup, probes/reselects a model,
re-embeds, seeds, imports, initializes documents or refreshes a profile. Pending
initialization, required profile refresh and selected model mismatch return
typed refusals. Readiness is checked before/after recall. Closing its originating
StartedMemory fences attached recall handles; each reader still requires its
own checked close. Readiness and local closed flags are functional state, never
owner/admission/shutdown evidence.

No request selects an employee ID, DB path, profile path or model. The real
installed namespace lifecycle/caller integration remains a required successor:
authenticate the current caller, serialize startup against recall, retain and
close all handles before shutdown, and replace the existing memory_cli consumers
through a path-free API. A host must not reinterpret a guest's filesystem or
loopback endpoint. Current Python/CLI consumers remain selected. Hands room
memory and the Office employee journal are separate stores and are not routed
through this legacy-memory service.

# Installing storage ownership

`InstallingBroker::new` consumes the actual service `WorkerRuntime` and creates
its reservation observer from that exact runtime's read-only handle. There is
no independent engine recapture, optional fake runtime or public registry setter.
The existing bootstrap currently requires the real reservation-control setup;
it is not yet the complete optional-reservations worker service.

`claim_storage` performs fresh service-selected resolution before the private
registry lock. Genuine legacy paths bypass the employee lock, census and
registry; employee claims retain actual move-only owners, recheck exact prior
bindings and census writers on the original same client. Fresh acquired guard
paths are retained even when the source permits an identity/kind change. Claim
handle Drop does not release a laptop-lifetime owner. Failed writer cleanup
retains the real unconfirmed owner and both primary/secondary errors; it cannot
be reused as a positive registration. Launch-wait bytes use strict metadata and
the original nine-field projection, separately from permissive allowed() data.

Exact claim-handle consumption settles the same native client before and after
local resource close; unknown close/settlement keeps a fenced registry entry
and returns the exact handle. It neither stops a container nor proves global
unlock, storage exclusivity, admission completion or capacity release. The real
launch/stop producer must also inventory and settle viewer/Office/other owned
constructor contexts and confirm native laptop disposition before a global
acknowledgement. Actual Nix ownership transfer, laptop registration, mutable
launch/recovery, and this terminal release caller remain required integration;
no plan, path, label or returned claim grants API or engine authority.

A release that already selected the source's unbounded mutex path remains in
flight when the first stop arrives later. The real stop producer must retain
that exact task and the registry's resources; it cannot infer completion or
restart a fresh cleanup budget. An owning control establishes that late stop
does not release the lease or finish the waiting task until the original mutex
is actually released. This is preserved source behavior and a required final
shutdown integration boundary, not a claimed whole-service 34-second bound.
