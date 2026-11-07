# Reverie application services

`RetainedPreparation::begin_native_start` reuses the live protected claim,
original source baseline and fresh complete qualification before the real
journal STARTING/version-4 transition. Its exclusive start-intent receipt and
second terminal qualification must both finish before returning the opaque
same-owner join. A failure closes the retained store and keeps the durable
claim; neither a receipt nor a cold journal read can reconstruct that join.
`inspect_native_start` returns readonly release facts through that same live
owner. It does not stop a source, bind a launch request, create/start a laptop,
acknowledge completion or authorize an API caller. Those actual producers and
the ordinary/no-reservations durable reconciliation flow remain required.

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

Native startup first adopts the actual `MemoryStartupStore`, performs finite
read-only preflight, and only then selects/probes its backend. The same retained
source/connection owner performs writer-reserved admission and publishes the
new closed native metadata namespace. Application workflow still owns
`initializing` → `profile-pending` → `ready`, including pending fences before
migration and profile effects. Project startup uses the same owner with its
independent hashed backend. Generic historical state never becomes native
ownership merely because strings match: old marker collisions, foreign or
malformed native metadata require an explicit migration/refusal, with no
force/skip/reset route. Unrelated rows, extensions and IDs remain; existing
selected-model vectors are retained, while explicit model changes use the
existing re-embedding workflow.
The existing lifecycle mutex/flock encloses preflight through inference and
checked resource closure; no SQLite connection survives between successful
curated calls. Legacy/raw writers must remain quiesced during actual cutover.
Standalone low-level callers must honor that same connection/lifecycle rule;
metadata success supplies no caller authority. Failed SQLite close retains its
actual owner and lock; consumed negative finalizers remain refused and still
attempt remaining namespace finalizers.

`memory_recall::MemoryRecall` receives the already selected model and opens only
an existing READ_ONLY store. It never runs startup, probes/reselects a model,
re-embeds, seeds, imports, initializes documents or refreshes a profile. Pending
initialization, required profile refresh and selected model mismatch return
typed refusals. Readiness is checked before/after recall. Closing its originating
StartedMemory fences attached recall handles; each reader still requires its
own checked close. Readiness and local closed flags are functional state, never
owner/admission/shutdown evidence.

The lifecycle adopts `NativeMemoryRead` before SQL qualification and backend
selection, retains the actual connection and source anchors together, and uses
the shared pending/refused shutdown distinction. A SQLite close refusal keeps
the database, scope lock and namespace fenced; a consumed source failure still
attempts the remaining namespace finalizers and never becomes a release receipt.

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
The broker and optional reservation gate now share the same actual installed
snapshot owner. Genuine feature absence bootstraps without creating control
state; a removed option cannot hide an existing marker or pending fence.
The checked feature getter reobserves those fences for an unreserved service
and refuses late appearance. It returns no no-op admission or start permit.
The complete canonical launch/stop service and its optional admission consumer
remain separate required lifecycle integration.

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

`ReservationGate::admit_ordinary_launch` retains the real thread/process-bound
allocation scope through ordinary launch checks. It refuses a durable active
reserved target, preserving the separate protected-start producer. Its
`check_creation` uses the original host-job, launch, exact admission/pool policy,
native capacity, retained-delta and final inventory order. Candidate ceilings
include existing committed and retained bytes. Checked success runs the final
native guard; checked body failure preserves the primary and close failures.
Closing this local scope does not prove global resource release or confer
API, container, protected-start or lifecycle permission.

`InstallingBroker::check_creation_budget` composes the distinct running-peer
names/registry union, optional inspect, ownership/running/PID/cgroup checks,
outside-pool ceilings, maximum workers and candidate swap before that explicit
gate phase. The absent-control branch retains the original pool/headroom rule;
present explicit control never falls back. `check_pool` retains the separate
activation/task-headroom phase. Both use the actual installing snapshot and
same runtime; neither registers a laptop or grants effects. Candidate swap is
read from the existing finite memory projection: the worker loader rejects
owner-authored `laptopMemoryPolicy` input.

The canonical launch's held lifecycle uses the private
`check_creation_budget_locked` continuation. It checks that the borrowed guard
belongs to this exact installed broker, then uses the same budget algorithm and
native client. The public standalone method acquires its guard and delegates to
that owner. A launch must not call the standalone method while already holding
the nonreentrant mutex, or release/reacquire the guard to avoid that deadlock.

Fixtures cover 55 actual legacy budget, 23 pool, 12 swap and two paired native
lookup-priority cases. These use synthetic engine results/owned files; separate
controls exercise the real held gate and controlled supervised Rust clients.
Actual storage waiting, owned Nix/laptop/Office/viewer registration, fresh
canonical invocation points and final settlement remain required before
selecting the complete worker service. No live company/engine or installed
runtime qualification is inferred from these tests.

`InstallingBroker::refresh_launch_configuration` implements the existing normal
launch's image-only refresh through the actual retained-path loader. It loads
before the lifecycle mutex, then compares against current RAM with Python's
full equality for `{**current, "image": loaded["image"]}`. It publishes only after
that check, under lifecycle → Gate state → active context → current-state order.
An entry that captured older data may adopt only this same image-only projection
under its original entry ceiling. The native origin, engine context, existing
operation bound and all previously retained snapshots remain unchanged.

Actual loader fixtures reproduce thirteen old `Broker.handle` prefixes, including
inactive NaN data, integer/float/bool equality and absent-vs-null refusal. Owned
race controls cover an old entry capture, a real pending client at the unlocked
preparation boundary and an older load publishing after a newer one. The latter
can leave RAM behind disk, as the source permits; reserved admission independently
refuses the image mismatch. The controlled pending-client case does not qualify
the full Nix workflow or laptop launch. There is no file write, engine create,
authorization, registration or global-release acknowledgement in this operation;
no-reservations policy reload and the canonical launch/lifecycle consumer remain
required before complete worker-service selection.

`StorageClaim::retain_nix` now performs the actual storage-to-Nix transition.
For an employee, the installing registry atomically replaces its direct owner
with the same Runtime-owned `NixWorkflow` before the first client can run.
For legacy session storage, the real owner moves into that Runtime record with
no invented employee lease or employee registry entry. Both retain the exact
service origin. Named preparation methods delegate to the existing held owner;
no caller home/scratch/path or generic filesystem editor is accepted.

`NixStoragePreparation::run` executes outside the registry mutex. Checked
one-shot `reclaim` restores the exact direct storage and returns the actual Nix
guard plus its result; a definitive retention failure returns the original
claim/guard. Unknown helper/client/removal outcomes retain the workflow and
refuse direct aliases, further preparation and release. Dropping a preparation
handle does not acknowledge settlement. Its resources remain held only while the
actual Registry/Runtime remains retained; the last owner/process exit supplies
no global-release guarantee. The complete installing service still needs actual
process-lifetime retention of unknowns or confirmed structured shutdown.
The application controller must retain these handles and settle them during
real launch/recovery/stop; the public resource result is not API authorization,
Gate admission, laptop ownership or global capacity-release proof. Ordinary
release already waiting on an unbounded mutex when stop arrives remains an
explicit whole-service shutdown obligation.

Six owned controls exercise actual legacy and employee locks, definite rejection,
image opt-out, a fixed supervised helper create/start/remove, a long helper with
the registry mutex available, and unknown create/removal retaining guards through
service stop. Helper effects are controlled Rust child processes and owned files,
not a live engine, company or production activation.

The Nix resource handoff also forwards the exact `prepared_path` returned by the
real successful Host workflow. Later rollback metadata cannot replace that data;
image opt-out/negative results provide no path. `into_parts` remains compatible,
so the actual laptop-mount consumer must retain the returned data alongside its
same original resource owners before composing create arguments.

`StorageClaim::prepare_create_plan` uses the existing effective-config resolver
once while retaining actual custody, then delegates to the one Host observation
owner. Unknown Nix/consumed owners refuse before another native lookup. The
existing `worker_launch::prepare_create` data API remains compatible and delegates
that same sequence. Same-runtime provenance and a plan are not an authorization,
a protected start, a supervised Created/Started result or a lifecycle registry
entry; those actual consuming producers remain required.

`NixStoragePreparation::retain_network` now atomically replaces the registry's
actual Nix workflow with the same Runtime's laptop record. It transfers the
original storage/Nix owners directly after checking the unique storage-owner
identity, request and genuine same-runtime/session Office phone. A pure refusal
returns every supplied input while Nix retains its actual resources. The legacy
path still creates no employee registry entry or imaginary lease. No engine
query runs under the registry mutex; `run` uses fixed network inspect/create
commands outside it, with the original shared capture and stop budget.

Known network results have one-shot return of those exact owners; employee
registry restoration uses the real returned storage object. Unknown native or
daemon outcomes keep the laptop record and refuse direct aliases/release. This
is not a laptop-created/started result, API permission or global capacity credit.
Owned controls cover both storage kinds, refused aliases, native cancellation,
available registry mutex during actual child I/O and retained resources at stop.
The full canonical launch sequence and its telemetry/cold-temporary fences,
private record/create/start, recovery, viewer and whole-service shutdown remain
required before selecting the Rust worker service.
# Recovery memory observations

`worker_recovery::verify_recovered_memory` applies the original effective-config,
namespace, repeated policy-digest, host-root and native-limit sequence to genuine
same-Runtime recovery inspection data. It shares the existing resolver and kernel
rule owners; no CID is invented to adapt the weaker legacy recovery data. The
complete recovery transaction is owned by InstallingBroker as described below;
source-stop and later create/start lifecycle still require their real producers.

# Installing telemetry ownership and the protected read operation

InstallingBroker captures the genuine CommandTelemetry from its consumed Runtime
before optional Gate/marker construction, preserving the Python constructor's
ordering. Disabled is captured configuration state, not an omitted or replacement
collector. A failed constructor returns opaque BrokerBootstrapFailure retaining
that same Runtime, snapshot and completed owners with its typed primary cause.
Its checked close settles actual runtime work and independently checks SQLite
owners before sealing. Ignoring an unsettled failure quarantines those owners;
settlement never upgrades the failed constructor or grants launch/release.
Office construction remains in its later recovery/new-laptop phase.

`handle_command_failure_report` delegates a real accepted Unix connection to the
fixed same-runtime T service and mandatory collector. It supplies no listener,
wire dispatch completion, browser owner authorization or company-selected path.
`close_command_telemetry` publishes the original first stop, seals/settles its actual
shared T/J connection records and checks pending Store state. The listener/dispatcher must
still join its actual caller-owned handler threads. This component result does not close
other Office/laptop/resource constructors or acknowledge global shutdown.

The original complete-create check remains mandatory after current running intent
and all Nix/account mounts, immediately before actual create. This bounded cohort
adds no data-to-start constructor; the actual protected/unreserved create and
whole lifecycle producers must consume this retained collector when they land.

`accept_worker_connection` is the actual fixed T/J caller over this same service,
current snapshot, and mandatory collector. A J result retains its real socket
and borrows its original broker; no request/configuration constructor exists.
`begin_ordinary` consumes it through actual image refresh, non-attach GPU cold
boundary, and real captured optional Gate admission. Entry failure retains that
exact connection; successful prefix close consumes the actual allocation scope
and socket without acknowledging storage, laptop, or global release.

`AdmittedWorkerLaunch::prepare_prefix` continues that same owner through actual
storage acquisition and its original ten-second wait. A one-shot counted
connection hold precedes the first claim and moves into the actual active entry;
waiting releases common admission before an old employee lease can settle.
The same lifecycle mutex spans paired active/name insertion, pending/fresh-home
storage preparation, runtime-directory preparation, create-plan observation and
the original first inspect. `InspectedWorkerLaunch` keeps all those owners
private; its request, snapshot and previous-inspection getters return data.
That previous inspection is sealed to the exact original plan and actual storage
owner. Host process-incarnation capture consumes it without an extra inspect;
readback alone does not enable ordinary replacement stop or release resources.

`abort` returns the actual retained failure. Its one-shot `close_transport`
attempts admission, own handler metadata and socket finalization, retaining
sibling errors and the logical hold/storage context. Even a failure with no
direct StorageClaim can still have an uncertain owner in the real registry.
Physical EOF and successful local metadata removal do not release that custody.

`classify_existing` now continues the same accepted owner through original
running-policy and optional memory verification, runtime/exit observation,
pane/attach checks, process capture, pool policy and initial creation budget.
Its closed result retains either actual reusable ownership or the original
Absent/Stopped/DeadPane/RunningCompleted cold target. Runtime-bound memory
observation keeps the actual cancellation token and first-stop deadline; runtime
receipt reads preserve the existing finite-writer FIFO behavior. A whole
configured-Gate control exercises the same held lifecycle and common flock.

Ordinary replacement stop, Nix/network and create/start completion, protected CLI receipt,
actual admission/canonical release, viewer and committed Started registration
still require their genuine continuations. Protected L/source-stop dispatch and
the real listener/global-stop producer also remain required. First inspect is
neither cold eligibility nor a data-to-start or data-to-stop permission.

# Actual running-laptop recovery ownership

`recover_laptops` uses the genuine mandatory-telemetry bootstrap and its same
Runtime. It performs the original optional admission/recovery checks, running-name
census, memory checks and ordered budget projections, then completes every selected
storage claim/validation before opening any phone. The original separate effective
configuration reads remain separate. Phones use the worker's captured socket root
at the late construction phase. The ordered registry changes only after every
constructor succeeds; a failed final admission check retains committed owners.

Each production recovered entry contains a real Office service/phone and actual
selected StorageClaim. The legacy storage branch adds no employee lease or lock
tree. Names, including nil sessions without a Gate, remain membership DATA rather
than exact CID/process or start authority. Test-only modeled membership refuses
actual recovery and cannot manufacture a production entry.

Failure cleanup attempts every newly created phone/construction and actual newly
acquired claim. Native close uncertainty keeps its actual storage owners. Last
broker Drop jointly retains the real installed snapshot/registry, storage registry,
recovery/Office owners, mandatory collector and report service when those states
are unresolved, contended or poisoned. An actual retained storage entry is included
even when a failed census returned no claim handle. This is process-lifetime
quarantine, without a normal-operation reference cycle or a durable death fence.

Office/query settlement alone never releases a recovered running laptop's employee
lease. Structured stop must own the real container, settle all actual native
constructors/processes and close resource owners before acknowledging release.
That whole-service stop, protected source stop, create/start, authenticated
dispatcher and production selection remain separate obligations.

The installed-Gate recovery controls use the real configured broker, same captured
Runtime, actual admission/journal files and fixed native custody/mount reads.
They cover held admission, success/failure final guards, nil and malformed-journal
refusal, and dual body/poisoned-owner cleanup errors with consumed-flock checks.
The controlled engine's empty inventory/name replies remain synthetic membership
DATA; these controls establish no real running-container or start qualification.

The named installing `retain_resource_draft` entry captures only a genuine
recovered employee-storage owner. It retains the original admission and the
lifecycle/registry locks while moving that exact acquired lease and Office owner
into a source record BEFORE the durable reservation claim. The canonical claim,
original baseline, admission finalizer and source join share that interval.
Ordinary release refuses the source record; neither closing the retained store
nor changing the employee's session reconstructs or releases the original lease.
A known pre-claim refusal restores the same box. Any possible durable claim or
failed join retains the source record and claim, with typed cleanup errors.

The standalone Gate `retain_draft` remains a read-side claim producer without a
source resource or effect authority. Actual Created/Started owners need their own
same-record integration; they cannot become Direct owners from paths or status.
The source-holder tests use the unchanged genuine bootstrap/recovery path and
same captured metadata engine; only kernel observations are controlled data.
Protected source stop, physical lease release, create/start and global shutdown
acknowledgement are not provided by this resource/durable-claim join.

`RetainedPreparation::stop_original_source` now consumes its actual private
STARTING intent together with that registered original source. It publishes the
existing source-stop attempt, qualifies the same claim again before dispatch,
resolves policy at the original late phase, and retains one move-only Host stop
owner inside the same source record. Native uncertainty, policy/PID/metadata
drift, failed phone close and failed resource close retain the owner and durable
claim; local client settlement cannot promote them to a stopped result or retry.
The actual recovered Office phone rejects and joins its tracked work before the
original employee lease can close. Final source removal follows the final native
admission check. Returned facts retain capacity and are not target-start authority.

Owning controls cover actual controlled child stop/kill/reap and physical employee
flocks, plus a genuine installed-Gate publication/CAS/STARTING join for an already
stopped source with explicitly synthetic kernel facts. They do not qualify a live
Docker source stop, ordinary legacy/network stop, the complete source-to-target
launch consumer, every process producer, global shutdown, or backend selection.

Classified ordinary reuse can now move the actual selected storage box, observed
plan, first inspection and bound receipt into the same bounded Host existing-viewer
record. The original accepted J, logical Hold, active metadata, configuration and
wait observation remain in the App continuation. It leaves the original lifecycle
before closing its actual allocation admission, and only that confirmed close can
reach the native viewer constructor. Registered restoration checks the same Arc
and both actual Host guards before taking the box, then restores Direct without a
fallible gap; genuine legacy storage adds no registry entry, lease, Nix or Office.

Native component close/restoration returns a retained whole owner, never a stopped
laptop, handler completion, canonical release or storage/global acknowledgement.
The integrated handler must freshly re-stat its bound receipt for EVERY outcome,
including peer EOF and errors. If completion requires stop, that actual stop must
precede viewer reaping, metadata/Office removal and final storage-live checks.
Those integrated finalizer joins remain open; the component API does not choose
them from EOF, X, an earlier receipt or local client settlement. Last-owner Drop
quarantines the existing resource and counted connection owners in this process.
The new owning controls cover genuine legacy, physical employee storage, a real
fixed PTY child, actual configured-Gate allocation close and negative dropped-owner
retention. They do not select the native service or qualify live Docker cleanup.
