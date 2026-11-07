# Linux native adapters

`captured_client` privately owns the pipe capture and retained child settlement
used by `engine_metadata`. Its command snapshot, argv and per-call output/deadline
policy come from fixed purpose wrappers. It exposes no public arbitrary-command
endpoint and supplies no engine, session or owner permission. Installing-service
variants must borrow the same actual context so a different policy cannot bypass
a pending constructor or pipe writer. The metadata wrapper retains its closed
CID/query allowlist, 20-second clamp, 4 MiB combined stdout/stderr capture bound
and UTF-8/exit checks. This matches `Broker.run_engine` through
`worker_cleanup.run_client`; the separate reservation JSON/schema decoder keeps
its existing 8 MiB bound. A decoder allowance does not widen subprocess capture.

`ReadonlyEngine::settle_owned` settles retained clients while allowing later
queries after verified cleanup. `close` first permanently seals admission under
the same mutex used for a new job, then settles only its exact retained client.
Neither method retries a query or confirms an engine/API effect. The existing
pidfd handoff, ordered exec, child signals and diagnostic syscall owners remain
unchanged; process groups and PTY relay are separate purpose policies.

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

The existing Python broker remains selected. The Docker namespace base and
task-perf artifacts are built by the separate Rust build-only policy-artifacts
package, with filtered actual crate/dependency inputs. Other build-time tooling
remains migration debt. Neither this library nor its
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

`InstalledWorkerEngine` captures one installing-service engine once. Its readonly
handles clone the same `Arc<CapturedClient>`: pending constructors, owned cleanup
and permanent close are shared, with no recapture or replacement runner. The
service's cancellation token is independent of API authorization; bootstrap,
UIDs and filesystem leases do not authorize a laptop start. Named Nix/laptop
effects still require their actual owned-resource and native-phase producers.

The installing service's `request_stop` captures its first stop once, publishes
the original 34-second shared budget before launch cancellation, and never
extends it on repeated calls. Readonly cleanup observations may still use the
same captured client before final close; no replacement runner is created.
Both `settle_owned` and `close` share the same first-deadline clamp; close also
permanently seals the context. The Runtime's retained Nix/network consumers must
settle actual resource-owning cleanup before the final client seal, or retain an
explicit unconfirmed result. A deadline bounds the wait/kill attempt, not kernel
completion or a guaranteed reap.

`reservation_control::PolicyTransaction` implements the fixed owner-file CAS
resource, including private temporary publication, directory fsync, retained
stamps and checked finalizers. Its bindings/receipt bytes are DATA; only the
application's actual retained claim and reload sequence can acknowledge them.
`broker_engine` uses the original shared captured client for the closed laptop
inspection query, with the source's 4 MiB/20 s policy and optional exit status.
It does not recapture a process context or expose arbitrary engine arguments.

`worker_intent::read_allowed` ports actual `Broker.allowed`: permissive company
UTF-8 text first, first matching session's vacation/desired-running intent, then
strict 1 MiB plan metadata only for detached sessions. Current-row selection
precedes UID lookup and fallback I/O; no storage/generation/owner check replaces
that separate policy. These are current intent facts, never start permission.

`creation_budget` supplies the original running-peer names and optional inspect
queries on the same captured client, with 4 MiB/20 s policy and no public argv
or engine recapture. Its kernel adapter reads only the fixed worker-pool and
proc paths, deriving PID text from parsed positive observation data. Existing
bounded read/checked-close primitives are shared; deadline checks bracket reads
and do not promise that kernel I/O always completes within a wall-clock bound.
The separate activation and creation-pool readers retain their different
integer/positivity and read-order rules. These snapshots provide neither
process/cgroup ownership nor authorization, a start permit or global release.

`worker_launch` owns the actual create-argument observation sequence: hashes,
separate fresh security/runtime rootless reads, GPU qualification, then hostname
metadata. `WorkerRuntime::prepare_laptop_plan` binds that actual observation to
its same captured engine and real `LaunchStorage` namespace/SID; its opaque plan
has no argv/reply-data constructor. Mutable image/resources are not frozen into
the bootstrap identity. This observation still grants no API/admission/start
permission; real moved resource owners and supervised lifecycle results remain
necessary. The compatibility argument API delegates the same observation owner.

`ObservedCreatePlan::inspect_existing` seals the original optional first inspect
to that exact plan observation, engine and storage owner. Its consuming dead-pane
and running-replacement capture methods preserve their distinct ID-check order
before the shared fixed `/proc` process-start reader. The resulting
`ExistingProcessIncarnation` retains the real observation and process readback;
another plan or a new storage acquisition at the same paths cannot recreate it.
Its getters and binding check remain data/provenance, not freshness or stop
permission. An ordinary stop still needs the actual application admission,
resource custody, repeated pane checks and fresh native/policy observations.

Each actual `LaunchStorage` also has a private per-acquisition identity, minted
only after successful lease acquisition or genuine service legacy resolution.
The observed plan retains that identity across moves and Nix preparation; a
new owner at the same paths/SID cannot satisfy it. `NixReturned` compares its
actual owner independently of status/path DATA. A consumed-unconfirmed owner
still refuses even with a matching identity. These are provenance checks, not
filesystem freshness, admission or permission to launch.

`worker_laptop` transfers a known successful actual Nix record, the same-owner observed
plan, checked request and genuine same-runtime/session Office phone into one
bounded record before fixed network inspect/create. It uses the same captured
client with the original 4 MiB/20-second policy and first-stop ceiling. Optional
inspect exit failure precedes JSON parsing; successful replies use the original
default-JSON/first-row/label rules. Network create is never replayed after admission.
Unknown replies/native cleanup retain the exact owners; original errors and
additional settlement failures remain data, not fabricated completion.

`WorkerLaunchHold` retains the original counted J record through application
resource acquisition and uncertain cleanup. Only that actual connection can
mint it once. `close_socket` distinguishes known physical close with lifecycle
still held from complete retirement; neither outcome acknowledges laptop or
storage release. Dropping a hold leaves the same record counted, and an opaque
descriptor close cannot be forgiven by logical release. Negative handler
bookkeeping uses pure same-record identity after close; forward progression
still requires the separate live-connection/held-resource checks.

The network phase has checked one-shot return of the same resources, without
closing them or acknowledging writer/capacity release. Last runtime/handle loss
quarantines unreclaimed records for process lifetime instead of dropping their
actual guards. This does not survive process exit or prove daemon reconciliation.
The application supplies the atomic registry transition. Its complete canonical
launch caller, stop/recovery, viewer and whole-service shutdown consumers remain
required. Network success alone cannot produce a created or started object.

The following fixed create consumer advances only that same successful retained
network record. It derives late account mounts from the retained original source,
uses the exact earlier Nix result, checks current storage intent, and calls the
same-runtime mandatory CommandTelemetry on the complete argv immediately before
create. A successful reply creates a real `CreatedLaptop` even if stdout is not a
canonical CID; failed or lost effect replies retain the record and cannot be
replayed or reclaimed as an absent container. Private publication then writes the
exclusive UUID launch record before runtime.json and checks every writer, anchor
and held-parent close before allowing start. Both primary and finalizer errors
remain attached to the same created resource record.

Publication deliberately refuses preexisting runtime.json symlinks/hardlinks and
foreign or group/world-writable launch parents before truncation. Actual original
Python prefix controls establish that those otherwise-valid inputs were accepted
there; these are explicit preservation corrections. Ordinary owned 0755 parents
remain valid. Inode/link checks pin the observed entries but cannot exclude a
later same-UID link or rename writer; the real installing lifecycle must serialize
those writers. Failed publication never unlinks a name or loses created custody.

`StartedContainer` acknowledges only the actual fixed engine start. It is not CLI
readiness, completed memory/cold preparation, protected authorization or an App
registry entry. Those real joins and the canonical pre-Nix App caller are still
required. Fixed native pane argv DATA reuse worker-child --pane-exit without a
new shell or program-selection endpoint.

`configure_started_laptop_memory` accepts that same actual `StartedContainer`
and advances its retained record once. It takes no caller config, name, CID or
cgroup path. An absent effective policy performs no memory observations or
effects, while the original deadline, stop deadline and cancellation still fence
local completion. A refusal consumes the memory phase and retains the created
owners; a renewed caller deadline cannot replay it. Selected policies require
the full host hierarchy and an exact running
engine identity before holding the PID incarnation, unified membership and
no-follow cgroup directory. Swap-only policy opens no high-limit writer.

A configured helper socket selects the existing identity-only Rust soft-limit
helper; it never falls back to direct writes. Otherwise the private direct
authority refreshes engine/local identity, checks the hard limit and original
deadline, then performs one write with checked close. After writer admission,
short writes, interruption, failed identity/readback and close errors become
`MemoryEffectUnconfirmed` with the typed cause retained. Both routes independently
use `ReservationKernel` for RAM/high/swap and ancestor readback, then refresh
identity and check the held target close. Only that result constructs
`ConfiguredMemory`; it does not complete cold storage, launch a child or publish
application readiness. The installing application and later lifecycle joins
remain required. Owned fixture controls do not establish installed enforcement.

`prepare_laptop_cold_temporary` advances the same known network record before
creation. Opt-in `clear` requires its real employee storage lease, complete fixed
engine census, canonical mount/process observations and all configured kernel
lease barriers. Its iterative metadata walk retains the original 4096-entry,
2-GiB and nominal 10-second limits. Preservation markers, hardlinks, mounts,
changed custody and unknown same-UID references refuse. Pending evidence is
durable before deletion; completion and every checked finalizer precede the last
pending unlink. Partial/error outcomes retain the same resource record and never
mint preparation or cold-commit success. Creation and post-memory cold commit
require the actual same-source report carried by that storage owner.

Clear's legacy regular metadata symlinks, uncapped text JSON, last-key-wins and
loose reservation/holder grammar remain supported. FIFO/device/socket metadata
now refuses before payload open: the original could block beyond its nominal
deadline. Deadline checks do not bound an individual kernel filesystem syscall
or codec call. Iteration avoids interpreter recursion exhaustion; it adds no
new depth cap. These observations still rely on the original trusted host and
serialized lifecycle boundary, not immunity to privileged/same-UID rename races.
Absent policy remains non-destructive and independently fenced.
`prepare_retained_cold_tmp` runs `retain-and-replace` before Office/network on
the SAME successful Nix record and its actual employee lease. The original
plan's raw configuration selects the fixed paths and configured lease bases.
Real canonical barriers, complete registered-lease inventory, fixed native
census and bounded same-real-UID reference scans precede durable pending intent.
Only fixed no-replace renames move the old root into its permanent `.keep`
envelope and publish a new private writable TMP. No old-tree enumeration,
payload read, removal or automatic reclamation occurs. UNKNOWN observations
remain explicit; definite references still refuse. Fresh attempt-owned lease
temporaries refuse occupied names instead of truncating a foreign partial file.

Network/create/memory retain the SAME private prepared proof. Post-memory
commit confirms the actual created CID, image, labels, sleeping entrypoint,
PID/start, fresh inode and real `/tmp` namespace binding. Bound publication,
lease/refscan descriptors and every local finalizer complete before a second
fixed same-record confirmation. All fallible caller/current/deadline checks
precede the final pending unlink; only in-memory phase/token publication follows.
Neither prepared JSON nor a durable BOUND_PENDING_RELEASE record can mint the
phase or repair an uncertain outcome. Failure preserves original and foreign
bytes, the actual resources and any pending fence, with no transaction replay.
The actual App lifecycle must consume these methods in the original order;
this source does not select an installed runtime, migrate live data, publish
memory contexts/grants or establish global writer/capacity release.
Fixed finish tests bind their synthetic fresh TMP onto `/tmp` in a private
user/mount/PID/network namespace while retaining the positive service UID.
They use a unique0700 current-system-account home fixture outside `/tmp`, so
the canonical gate's short `/tmp` override cannot hide their own controls.
The ordinary reference/permission cases and required UID0 reader case keep
their existing namespace/capability semantics. These are synthetic native
resource tests, not an OCI-image or installed-launch qualification.

`release_laptop_nix_guard` consumes only the original guard after the same
record's acknowledged pane startup. It moves the actual storage, original Nix
outcome and prepared path into that record before attempting checked descriptor
finalization. Failed finalization retains cleanup custody and cannot be retried
or produce `NixReleasedPane`. Successful finalization preserves the employee
storage lease and allows immutable created-CID cleanup. This local close does
not prove a globally free flock or release application admission. The installing
caller must publish any protected CLI-start receipt first, then actually release
admission and publish canonical release before starting a viewer. Any later
forward consumer must recheck the same record's current phase; an old token
cannot revive a record that entered terminal container cleanup.

`start_laptop_viewer_session` retains its concrete PTY/session constructor in
the same bounded laptop record before native work. It shares the existing
captured-client constructor slot, then hands the running viewer to that record
after joined construction and checked finalizers. Forward I/O holds the same
record through each operation. Cleanup retains the original leader until its
final owned-group decision, then confirms group absence without further signal
delivery. Failed or incomplete cleanup keeps the actual owners. See the
[viewer boundary](src/worker_laptop/viewer/README.md) for the measured legacy
cleanup correction, original deadlines and remaining transport/reuse joins.
This created-only primitive does not establish application admission release,
guest resize acknowledgement or whole-service/resource settlement.

New-target cleanup accepts only the canonical CID retained from that actual
create, never a recycled name or a caller CID. It preserves stop/inspect/kill/
inspect order but requires an exact, known stopped state. Missing/failed inspect,
unknown replies, and successful noncanonical create output cannot establish
absence or release. This explicit conservative difference is bound to actual
original ordinary-stop controls. Cleanup captures one original end and honors
first-stop; repeats cannot renew it or replay effects. Cleanup enters a terminal
state under the same record mutex before any settlement or native effect, so no
later publication/start can revive it even when global stop is unset. A cached
stopped result is valid only in that terminal stopped state. A prior unknown
forward effect stays uncertain after local client settlement and cannot produce
a stopped acknowledgement. Its local stopped result
retains Office, Nix/storage and request ownership and provides no capacity,
resource-release or whole-service acknowledgement.

Protected-start qualification observes the captured old PID incarnation both
before and after its fixed cgroup/events check, preserves all captured storage
identity tuple fields and visits original account sources in capture order.
Missing old processes/cgroups remain source-compatible; populated, rebound,
malformed or inaccessible cgroups cannot prove release. In particular, an owned
UID-1000 differential witness establishes that Python `lexists` silently accepts
an inaccessible ancestor over a populated cgroup. The Rust shared fixed-kernel
reader deliberately preserves its PermissionDenied refusal instead of granting
false absence credit. These are observations, not a held writer-release proof.
# Worker recovery and lazy Office observations

`worker_recovery` retains the actual Runtime origin for the original running-name
census and optional single-container inspection. Raw recovered names, including
bare/nil UUID spellings and last-name selection for one SID, remain membership
data. They do not establish exact container/process custody. Recovery memory
verification shares the existing native limits reader without imposing the
inventory's stricter CID schema on the original ignored `Id` result.

`OfficeService::from_worker` captures the same Runtime and defers the fixed server
inspection until an actual forwarded request, after host credential processing.
Its Company-local two-second cache preserves the original IP/scope codepoints;
socket conversion reuses the existing Python IDNA2003 owner. Request futures and
their native query/DNS threads share actual local/global request seats. Cancelling
HTTP cannot free those seats or acknowledge close while owned native work remains.
Checked Company close attempts every job and phone; unresolved owners survive an
accidental service drop in process-lifetime quarantine. Neither this quarantine
nor a closed phone establishes durable recovery or global shutdown.

# Retained Office construction failures

`bind_retained` returns a genuine failed-construction owner only after its actual
registry insertion. That type cannot become a completed `OfficePhone` or a start
grant. Known failures before ownership, or after confirmed constructor cleanup,
return no owner. `close_construction` checks the exact Company and retained entry;
even another Company on the same Runtime cannot close it. Consumed-close and
unidentified-leaf failures remain negative across repeats. The compatibility
`bind` retains its original constructor/error order and delegates the same owner.
Recovery must keep its real storage resources while construction cleanup is
unconfirmed; neither a failed-construction token nor successful local close
acknowledges global release, durable reconciliation or authorization.

`bind_worker_retained` has no directory argument: it uses only the raw
`apiSocketRoot` captured by the same `from_worker` configuration. At the actual
phone phase it preserves the original `Path(root)/SID` recursive mkdir effects
and refuses a final SID symlink, then resolves the root with the existing Python
path owner before the private anchored bind. Missing components before `..`
are created; regular-file traversal fails before resolution. Created directories
remain on later failures. Trusted fixed-address constructors and their direct
bind restrictions are unchanged. Root resolution grants neither writer exclusion
nor authorization, and the existing no-overwrite socket policy remains in force.

# Telemetry consumers
The worker constructor checks and retains the mandatory telemetry object's
Runtime origin. An enabled collector serves the fixed hands route locally using
the phone's constructor-selected SID; the trusted fixed-address constructor
keeps its original absent-collector behavior. The closed native-job purpose
retains actual request seats through thread settlement after HTTP cancellation.
Company close/drop independently inspect the same collector's pending SQLite
owners; a joined thread cannot forgive a refused database close.

`worker_reports` implements fixed T/J dispatch on an actual owned accepted Unix
connection, not a listener or generic command dispatcher. Actual kernel UID precedes
frame/collector access. The shared 256 KiB transport check precedes allocation;
the complete common frame precedes the existing 4 KiB request-purpose check.
Original 10-second per-receive and whole-sendall budgets, plus first-stop clamping,
are retained; partial send progress never renews that attempt's deadline. EOF and
connection loss close quietly. Interrupted receive waits keep their original
monotonic deadline; only positive byte progress begins another recv budget.
The receive-attempt behavior follows the pinned
[CPython 3.13.15 socket implementation](https://github.com/python/cpython/blob/v3.13.15/Modules/socketmodule.c#L822).
Operation refusals send one E, and successful
closed reports send J. Independent report admission still refuses rather than
queuing another batch. Checked socket finalizers, bounded retained connections,
and uncertain-close quarantine are separate from report success. A refused socket's
unconfirmed close fences further admission and retains the same engine origin,
even when no connection record was admitted; its consumed descriptor is never
retried. Native kernel
or filesystem latency is not claimed to have a hard execution bound.

The same service's `accept` returns either an actually finalized report or an
opaque `WorkerLaunchConnection`, retaining that J socket in the same bounded
registry and installed engine origin. The request codec preserves original
field/codepoint/ordering rules; an accepted request is not an allocation or
start permit. Checked J close is terminal, and a refused close retains that
record. Service close interrupts it but cannot acknowledge completion while
the actual J owner remains. Nineteen original Python schema/encoding recipes
are compared with full actual socket outcomes. Detailed CPython malformed-JSON
and byte-decoding diagnostic text is still a separate compatibility obligation;
the existing request codec retains only its typed JSON refusal.

These consumers do not recover/register laptops, stop a source, create/start a
container, mint API grants, or select a backend. Complete-create argv must still
reach the actual collector immediately before the genuine create producer.

`worker_source_stop::OriginalSourceStop` owns the actual original employee
resource, same captured engine and original process baseline. Header inspection
precedes the App's late policy resolution; distinct fixed `/proc` observations,
immutable-CID stop/inspect/kill and exact metadata readback precede its terminal
stopped phase. Wrong origin is refused before mutation. A failed or uncertain
attempt cannot dispatch again or become stopped merely because its native call
settled. Consuming the original resource is a separate one-shot phase, and the
App must first close the actual Office/request owners and requalify its claim.
Drop retains unknown actual resources in a process-lifetime quarantine; it is
neither a durable fence nor global process/writer release acknowledgement.

`retain_existing_viewer` moves the original storage box, observed plan, request
and sealed first inspection into the same bounded laptop inventory used by
created viewers. It performs only pure origin/binding checks. The App must
retain its actual classified reuse, J/hold, lifecycle and admission owners and
complete admission release before calling `start_existing_viewer`. This branch
creates no Office phone or Nix/created-container token. Both viewer origins use
the same fixed native session, PTY, captured-client constructor slot and I/O.

`close_existing_viewer` terminally fences the record and settles its exact job;
it does not release storage or acknowledge global completion. A reclaim guard
keeps the same box counted until `into_parts` moves it once under both retained
mutex guards. The App must validate/hold its registry before this infallible
restoration step. Dropping that guard leaves the box in the record. Unknown
construction or descriptor close retains the box and job. The App owns actual
reuse transfer and finalization. Cold/Started reuse and whole-service drain still
need integration; no backend selection follows from this Host component.

Broker handler construction now splits registration from the same initial
reader. An opaque registered socket is counted before any real thread exists.
Its nonclone construction owner publishes the actual JoinHandle; the child
waits and compares its actual ThreadId before configuration/frame work. Joined
handler, known socket close and logical Hold release remain distinct facts in
the same record. An arbitrary supplied spawn error cannot prove no thread:
known refusal additionally requires actual unread-token Drop on its recorded
constructing thread. Abandoned/mismatched publication, panic or consumed-close
uncertainty remain counted. The real listener/all-verbs dispatcher and complete
startup/shutdown assembly are still required; this is no service-ready result.

Actual worker socket/Hold finalizers use named `*_for_worker` methods with no
independent aggregate before stopping. Every contended lock acquisition observes
the same live first-stop deadline, including a stop published after waiting began.
Explicit bounded component entrypoints remain available. Native handler collection
reports only thread settlement; a held resource or opaque descriptor still counts.

`OrdinaryLaptopStop` is the separate legacy/stopped-name cleanup owner. Its
observed constructor consumes the same Box, plan and original sealed inspection;
the unobserved constructor consumes the same Box/plan and requires an actual
first observation. Neither constructor creates a process incarnation or a
protected/Created/Nix token. App performs its actual common stop admission first.
The native owner preserves optional stop, inspect, conditional kill and inspect,
plus owned-label network cleanup. Foreign network labels remain a no-op.

Explicit safety corrections apply to this legacy branch: a fresh identity
observation precedes effects; container and network commands target captured
immutable IDs; stopped acknowledgment requires positive boolean false or a
successful complete absence census. Failed optional inspect and falsey malformed
state no longer release storage. The original conditional-kill truthiness and
first-row JSON behavior remain DATA semantics. Owned network removal requires
confirmed absence; uncertain cleanup retains the actual Box and call. Local
native settlement never upgrades an unknown provider result or permits replay.

`stop_existing_viewer_laptop` uses that same private algorithm inside the actual
bounded existing record. It covers Held/no-Job, Viewing and retained constructor
phases without fabricating a viewer. Any present job remains unreaped through
stop; the App must stop before closing it. An attempted stop forbids a new
constructor, and unknown stop independently prevents Box reclamation even after
query/viewer cleanup reaches Closed. Actual App admission/current-source/receipt
and handler/lifecycle owners remain mandatory; no global release follows from
the Host stop result. Recovered/stop-all owners and full caller adoption are
separate required integration work.

The named connection-bound relay factories derive the request from the original
accepted J and retain its actual record identity before native construction.
Created launches capture that identity before network/create and preserve it
through guard consumption. Native-only component factories cannot acquire this
identity afterward. Another same-SID J cannot start or relay that viewer.

`begin_viewer_relay` serially implements I/R/O/X on that same socket and native
job. It reuses the common framing/deadline owner, writes complete input through
PTY backpressure, drains raw output before X, and retains exact resize-query
constructors. Resize confirmation requires the full inventory, exact marker and
size; an uncertain query blocks later confirmation even after local settlement.
The fixed live resize report is bounded rather than Python's blocking flush;
failed delivery propagates before a later receipt/X. Streaming completion reads
preserve Python UTF-8/integer semantics without imposing a new file-byte cap.
Detailed malformed JSON/receipt diagnostic text remains a compatibility limit.

Transport termination neither reaps the native leader nor returns storage. A
fresh same-record receipt observation remains available before cleanup, including
Held/no-job failures. The App's reuse finalizer classifies it on every outcome,
performs any required real stop before reap, then checks final liveness and the
exact captured Office owner under fresh admission. Direct-prefix and Cold/Started
cleanup consumers remain required. No live Docker, service activation or global
release claim follows from the component controls.

The genuine broker callers use `retain_ordinary_laptop_stop_for_worker`,
`retain_unobserved_ordinary_laptop_stop_for_worker` and
`stop_existing_viewer_laptop_for_worker`. Like original `Broker.stop`, these
choose no aggregate body deadline: each fixed client call retains 20 seconds,
clipped to the service's actual first-stop budget. Existing `Instant` component
entry points remain available with their explicit caller cap. Native settlement
has its separate supplied cleanup end; it cannot retry effects or clear failure.
The genuine worker path also waits for shared-client admission only after a
typed before-start Busy result with no captured call and no possible start.
This uses the same original per-query end, rechecks the live first-stop bound,
and dispatches no command while waiting. Admitted tickets and every other error
remain failed without replay. Exact-source and bounded component admission
behavior is unchanged.

The standalone broker's `install_broker_signals` owns the actual fixed native
SIGINT/SIGTERM guard on the same runtime. Its existing cancellation-token clones
observe that installed source directly; no watcher grants a later 34-second
budget. Native first-signal and manual first-stop deadlines take their minimum.
Unrelated/default tokens do not acquire a signal source. Before restoration the
source freezes, so a later standalone installation cannot alter an older engine.
Restoration requires an actually closed captured client; this local observation
does not certify all App/Office/storage cleanup. Unknown Drop or restoration
retains the actual guard/origin and refuses replacement. The actual listener,
all command producers, supervisor and complete service close remain required
before replacing the Python broker entry point.

Known exact and legacy stop returns additionally expose `into_cold_parts` with
a move-only `StoppedLaptopRemoval`; existing tuple APIs remain available. The
token binds the actual original storage owner, installed Runtime, session and
immutable old target. It cannot be reconstructed from inspected data. Actual
Cold callers carry it separately while that same storage moves into Nix. The
named post-Nix removal requires the same successful Nix record and current guard
and original plan, after the caller's real lifecycle/current-policy/writer/budget
rechecks. It does not rerun create arguments or require a new observation brand.

Removal uses fresh strict stopped metadata followed by required non-force
`rm CID` and a complete successful absence census. Exact-origin metadata keeps
its existing projection; legacy-origin checks only its original identity and
worker/session binding. An absent old target cannot authorize removing a new
target which later takes its name. This deliberately corrects original post-Nix
`rm name` retargeting. Each worker call retains its original 20-second bound and
live first-stop clipping without an aggregate body cap. A failed, restarted or
uncertain outcome stays in the same counted Nix record with its actual pending
call, storage and guard; native settlement permits neither retry nor success.
Only checked success mints `RemovedStoppedLaptop`, bound to that same record.
These components do not implement the outer Cold/J continuation or select a
native backend, and they grant no storage release or global shutdown receipt.

Broker socket preparation and bind retain the same runtime through failed
constructors, checked descriptor close and pinned-name cleanup. The listener
registers each actual accepted connection directly in the existing reports
inventory before any peer/frame work; it adds no second connection cap.
The App startup prefix performs actual signal installation, pool checking,
socket preparation and recovery in source order, and does not bind before
recovery. Supervisor, lease-peer, complete verbs and final service close are
still required before this prefix can become a runnable broker.

The stale probe deliberately uses a newly owned nonblocking socket. Unlike the
legacy blocking connect, a full/in-progress foreign backlog refuses startup
without waiting, unlinking or chmodding the foreign name. Only ECONNREFUSED
permits removal of its pinned matching inode. This is a startup availability
correction, not a hard filesystem/kernel latency guarantee. As for Office,
metadata comparison is not atomic against later same-UID namespace writers;
the actual service lifecycle must exclude those competing writers.

The actual created and existing worker viewer constructors accept the original
accepted J connection and choose no aggregate construction deadline. Their
shared admission, constructor wait and identity-checked slot handoff observe
the same runtime's live first-stop deadline. Existing caller-bounded component
constructors retain their supplied ceiling. A Busy query remains owned by its
original captured call; waiting neither cancels nor replays it. A stopped or
uncertain viewer constructor remains in the same laptop/native inventory with
its real storage and job. This timing join does not establish App allocation
release, complete handler cleanup, storage release or global shutdown.

Worker viewer cleanup keeps distinct guard, TERM and KILL phases. Without an
existing stop, guard acquisition gets the original 5.1 seconds; otherwise it
uses the original first-stop end. The five-second TERM grace begins only after
the real record, constructor and native state are acquired. KILL then gets its
original 100 milliseconds, clipped by the caller and live first-stop limits.
Each phase stays fixed on retry. Existing caller-bounded methods keep their
original aggregate cap. Native cleanup advances before potentially blocking
query settlement: a retained resize, stop or final-read constructor must not
hide the owned viewer. Actual provider stop effects still precede viewer reap.
Unknown native/query owners and both causes remain retained; only actual join
and checked process/PTY/query completion stamps the private close receipt.
That receipt alone grants no storage release or global shutdown acknowledgement.
