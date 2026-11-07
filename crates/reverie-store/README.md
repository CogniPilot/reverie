# Reverie profile store

## Resource operation journal

`operations::OperationStore` ports the existing `operations.json` and
`operations.lock` journal. Initialization is explicit and requires an empty
existing private directory. A missing/corrupt/inaccessible journal never becomes
an absent lookup result. Private custody is current-euid mode0700 directories,
mode0600 single-link regular files, no-follow ancestor traversal and a real
nonblocking exclusive flock. Profile and operation stores share the reviewed
descriptor/stamp/temporary-pin implementation; their public APIs keep fixed
separate leaf names and expose no generic file editor.

Trusted service installation supplies a live scope guard and optional capacity
observer. Those must remain inside the real host admission transaction; repeated
observations do not create one. A scope digest or reference ID is not approval.
Each new positive delta stays charged across cancellation, restart and recorded
verification. Shrinking never creates capacity credit. Replays return a view,
never a fresh effect handle; cold views show protected recovery and cannot retry.
`OperationView::record` retains the canonical row separately from that presentation
state, since a cold RESERVED row keeps version1 while showing recovery.

Writes use a pinned private temporary, complete writes, file fsync, guarded CAS,
rename, directory fsync, readback and final scope/root/lock/document checks. A
rename attempt or later failure revokes all local handles and returns commit
uncertainty; it never deletes a claim, rolls back or grants replay permission.
Both primary and finalizer failures remain available. Initialization additionally
uses atomic no-replace publication so a concurrently installed journal is retained.

All begin/ACK/recovery phases and the completion journal transaction are present.
`NativeCompletionProof` has no production constructor or inhabited source variant.
Only owning tests can instantiate an inert fixture proof. The actual
`worker_resource_finalization` settlement producer remains a required dependency:
the application must own its live owner/readiness and pending-marker workflow,
with typed native observations and terminal finalizers, before a reviewed mint
seam can replace this unavailable boundary. No store-to-host dependency or
callback/digest/wire completion mint is introduced. COMPLETED journal data alone
does not prove native settlement or release the outer pending fence.

Tests use owned files, genuine separate processes, post-install child termination,
capacity races, restrictive umask and close/rename/fsync/rebinding faults. Existing
profile-store finalizer tests remain unchanged. The active Python broker/journal
consumer stays selected pending the coordinated full broker migration. No engine,
kernel effect, public endpoint, live company edit or production cutover is provided.

## Canonical profile persistence

This is the C1 Rust persistence component for the existing
`reverie-employee-resource-profiles-v1` schema. It uses `profiles.json` and
`profiles.lock` in an existing private directory. It creates no endpoint,
sidecar, editor CLI, native effect permit or alternative store.

`reverie-core` owns checked profile/resource/revision values and pure CAS intent.
`reverie-contracts::profiles_v1` owns the closed schema, byte limit, exact legacy
compact ASCII encoding, and distinct document/profile digests. This crate does
not deserialize arbitrary JSON again or substitute another canonicalizer.

## API and consistency boundary

- `ProfileStore::open` opens an existing current-euid mode-0700 directory through
  descriptor-relative, no-symlink traversal. It never initializes a directory.
- `observe_existing` reads without creating a lock or data file and retains
  `Missing` versus `Present`, including a present empty revision-zero document.
  The returned data/metadata is not authorization, admission or native proof.
- `read_existing` is a convenience returning the observed document; the legacy
  missing-document result is an empty revision-zero profile document.
- `snapshot` holds the real nonblocking `profiles.lock`; it may create that
  mode-0600 lock, preserving the legacy behavior.
- `locked_read` retains that same lock through application staging. Its immutable
  document is data; the caller must check `finish` before acknowledging a derived
  candidate. An open read descriptor pins the observed data inode throughout
  staging. Finalization checks its stamp, named data presence, directory and
  named lock, then closes the lock with errors retained. Abandoning a guard
  releases it without acknowledging the candidate or writing any configuration.
- `put` applies a checked store-revision/profile-version/previous-binding CAS
  intent under that same lock. It never writes broker configuration or allocates
  a resource.
- `close` consumes the store and reports a close error. B must include checked
  closure in its application/native acknowledgement boundary.

The application remains responsible for current owner authorization, selecting
the accepted store directory and its existing outer admission guard. B's
bound-domain checks must use presence-bearing `observe_existing`; an empty
document is not proof of a missing file. Read observations require the same
trusted guard before and after use as their current Python consumers.

Existing-target CAS is cooperative through `profiles.lock`, with custody,
named-file identity and readback checks. It is not an inode-conditional atomic
rename against arbitrary same-UID noncooperating editors. Such editors must stay
quiescent; the trusted private namespace/outer admission boundary is retained.
Absent-target publication additionally uses `RENAME_NOREPLACE`.

## Publication and uncertainty

Store and lock files must be owned, mode-0600, single-link regular files. Reads
are bounded and reject changes or named-file replacement. New files are chmodded
explicitly, so a restrictive umask cannot silently create an unreadable store.

Preparation creates an exclusive temporary, keeps its inode pinned by an O_PATH
descriptor, writes/fsyncs and reads back exact canonical bytes, then checks its
current name, contents and metadata before publication. A substituted temporary
is retained rather than removed. The O_PATH anchor prevents inode-number reuse
from fooling cleanup into deleting a replacement.

Publication is marked attempted before the rename syscall, including an install
whose acknowledgement is lost. Directory fsync, root/lock/readback checks,
temporary finalization and a final named-data stamp precede the checked lock
close and success. Every later error becomes `CommitUncertain`; no automatic
retry, rollback or old-revision restoration is performed.

Primary and finalizer failures are both retained. If initial creator metadata or
permissions cannot be established, its newly created leaf remains private
evidence and the error identifies retained preparation. This is distinct from a
publication attempt; it does not claim that the target profile changed.

Unsafe Linux calls are isolated in `src/private_fs.rs`. Fault injection is
compiled only into owning-crate tests and has no feature, wire or production API.
Process fixtures use a separate integration-test executable: they must not fork
while unrelated unit-test threads hold transient flocks. Thread and process
contention still exercise the actual nonblocking lock.

## Legacy coverage and pending B integration

The four original suites define 26 cases. The following map keeps their storage,
type and staging responsibilities explicit; it does not claim that B's pending
projection or native actor has migrated.

| Existing case | Owning Rust coverage or remaining responsibility |
| --- | --- |
| base: persist/reload/new-SID exact policy | C persistence/reopen; new-SID projection remains B |
| base: central pool projection | B `stage_config`/policy projection pending |
| base: missing profile has no default | C preserves absence; B must refuse missing required profile |
| base: stale revision/version/binding | C locked CAS and core checked intent |
| base: unrelated employee preserved | C unrelated-profile preservation |
| base: same SID/foreign SID | C/core same-SID compatibility; B SID-owner check pending |
| base: staging identity drift | B projection/approval binding pending |
| base: strict fields/types/nonfinite | A checked types/codec; C refuses invalid input files |
| base: duplicate/oversized document | A codec and C bounded reads |
| base: symlink/FIFO/bad mode | C custody refusals without repair |
| base: concurrent same revision | C real thread and two-process contention |
| base: rebound directory | C no-symlink directory/inode guards |
| base: returned copies | A immutable values and C independent returned documents |
| independent: rename failure preserves old data | C fault test; attempted rename is conservatively uncertain |
| independent: file fsync failure | C prepublication refusal and owned-temp cleanup |
| independent: directory fsync failure | C uncertain commit, new revision retained |
| independent: rebound directory at commit | C uncertain commit, original namespace retained |
| independent: restrictive umask/readability | C isolated process fixture and explicit chmod |
| independent: hardlinked data/lock | C private regular single-link checks |
| independent: type-sensitive binding/version | A checked constructors/codec and C CAS |
| independent: exact unrelated staging digest/copies | B projection pending; A owns profile digest bytes |
| independent: foreign target/missing pending profile | B canonical SID-owner/profile requirement pending |
| independent: short reads/data changes | C bounded read completion and mutation refusal |
| successor: rebound commit uncertainty | C explicit uncertain outcome with retained revision |
| successor: post-rename I/O uncertainty | C typed uncertainty and retained primary/finalizer errors |
| commit: first creation under restrictive umask | C isolated child fixture verifies data and lock mode0600 |

Additional Rust controls cover rename acknowledgement loss, temporary
substitution/content/link/mode changes, named-data/ancestor replacement,
post-finalizer same-bytes replacement, partial/zero writes, close failures,
descriptor cleanup and missing-versus-present-empty observation.

The full `stage_config` consumer requirement is still open: B must preserve
employee/session projections, global pool policy, unrelated grants, ownership
checks and the separate spaced-JSON worker policy digest. The current Python
preparation, reservation, bootstrap, finalization and terminal-binding consumers
remain selected until a coordinated B migration consumes this same Rust store.
Do not delete their Python profile implementation or introduce a fallback while
that selection remains pending.

Run `nix develop --command cargo xtask verify` with a task-specific temporary
`CARGO_TARGET_DIR`. Source/fixture results do not activate a host or establish a
successful native resource operation.

## Read-side employee storage identity

`storage_identity` resolves the existing employee/session storage namespace from
trusted native configuration paths. Its `read_metadata` walks without following
symlinks and verifies configured UID, single-link regular type, non-group/world
write permissions, byte bounds and fd/named-file stamps. This metadata policy
intentionally differs from the private profile store's exact mode0600 policy;
no profile-store custody requirement is relaxed. Checked close failures refuse
the read, retaining both primary and finalizer failures where necessary.

Current and retired company records, persistent `storage-owner.json` lineage and
historical `plan-moves.json` edges resolve an employee's stable data identity.
Unbound sessions retain their separate legacy SID namespace. Canonical state
and scratch paths may have nonexistent or inaccessible tails, retaining Python's
`resolve(strict=False)` data behavior. Lexical normalization and observed-symlink
checks do not prove custody or usability beneath an inaccessible directory;
`read_metadata` independently traverses no-follow descriptors and refuses
unknown/inaccessible read paths. Resolving facts creates no files or directories.
Unrelated opaque IDs are retained instead of being forced into
UUID types. A selected employee/session storage identity is checked separately.

`storage_start_allowed` rechecks storage facts and current running/vacation flags;
it is only one input to the existing outer session/owner/admission gates.
`current_employee` repeats current-registry and storage selection to refuse
binding/generation drift, while retaining arbitrary positive integer generation
values. It deliberately does not use running intent as a GPU identity gate.

The resolver neither prepares storage nor writes lineage, acquires lifetime
leases, publishes a migration, creates a sidecar/endpoint or selects a new
production consumer. The caller supplies trusted native paths and remains
responsible for authorization and consistency across its complete workflow.

`StorageIdentityConfig::capture_worker_settings` retains same-captured worker
path text as DATA and delays encoding/canonical checks to their original read
phases. Company and history reads precede later state/scratch canonical refusal;
indexed lineage first uses Python's normalized Path spelling. Non-encodable
index lookups remain absent only for that existence test, while later actual
canonical/read operations still refuse them. The strict eager `try_new` contract
is unchanged. Both paths reuse the same metadata custody and pure `posix_text`
conversion owners; neither establishes a lease or usable-path proof.

`read_ordered_metadata` shares the exact native metadata reader and its named
parser, retaining Python insertion order only for consumers whose subsequent
native observations depend on that order. It exposes no parser choice or editor.
`OperationStore::into_exact_terminal_stamp` consumes a fresh exact journal
reader, closes both its reader lock and owned store, and retains dual errors
before returning opaque original named-generation data. The terminal admission
hook defaults to the ordinary full scope guard; only the actual Gate may supply
its narrower held-admission check for this readonly phase. Ordinary snapshots
and mutations retain their existing checks. The stamp cannot grant completion,
capacity credit or effects; the caller must still perform its final native
guards and then assert the original named stamp without reopening the journal.

Fixed installed scope/capacity guards can retain their complete source failure
through `JournalError::guard_failure`; stable codes still drive decisions.
The boxed cause and outer secondary close errors remain available to trusted
diagnostics. No callback, guard authority or completion proof is created by
constructing an error value.

## Employee and project memory persistence

`memory::MemoryStore` preserves the existing memory SQLite schema, row IDs,
native-endian float32 vector BLOBs, metadata/source JSON, claims, state, beliefs
and dream summaries. Initialization migrates the legacy assistant column and
schema version without resetting rows or re-embedding. Unknown extension tables
(including documents and ballots) survive initialization, backup and restore.
This uses ordinary SQLite filesystem behavior; it does not weaken or reuse the
private profile store's stricter custody rules. The installing service selects
and authorizes the employee/project namespace. No operator database editor or
production consumer is introduced.

Scalar convenience inputs coexist with lossless checked Python-text inputs for
queries, model names, records and voice normalization. SQL TEXT binds still
reject unencodable surrogates at their actual boundary, after embedding where
the source does so. Source-ID JSON retains arbitrary integer width and existing
`list(source_ids)` iteration. SQLite connection-local defaults explicitly match
the legacy foreign-key and secure-delete settings. URI-looking names remain
literal files; empty MemoryStore paths retain the source's directory refusal,
while `:memory:` aliases remain ephemeral.

Transactions preserve the existing commit points, including explicit operations
that commit an outer atomic prefix and failed re-embedding that leaves a prefix
uncommitted. A write's own transaction rolls back a failed COMMIT; explicit
`atomic` leaves that failed transaction open, matching the two Python contexts.
Retrieval uses the pinned CPython ranking policy, including NaN run ordering,
and returns pre-touch access timestamps while committing the selected touch.

The new curated `backup_to`/`restore_from` endpoints copy every SQLite table and
original BLOB. Their caller authorizes paths and quiesces other writers for
restore. Same-file, symlink/hardlink aliases and ephemeral snapshot names refuse;
copying has a two-second budget instead of an unbounded busy loop. Restore first
qualifies and migrates a private SQLite temporary. An error after attempting
destination replacement reports uncertainty and retains the selected snapshot;
it does not claim rollback or remove a recovery file. Checked connection-close
errors retain primary and finalizer failures. Synthetic Python-created databases
and an explicit reverse-interop qualification cover both language directions.

`MemoryReader` opens an existing SQLite database READ_ONLY, including its live
WAL. It never creates directories/tables, migrates, seeds, imports, reselects a
model or touches last_accessed. Its retrieval shares the writer's exact query,
scoring and ranking owners. Missing/partial boot data and a legacy assistant
column refuse explicitly. Read-only SQLite may coordinate existing WAL/shared
memory files; this does not promise a filesystem with no ancillary changes.

`NativeMemoryRead` stages the actual read-only connection and its pinned source
before schema qualification or model work. The application stores that owner
first, then moves the same connection and anchors into the qualified profile
and reader. Native reads recheck the held/named source around SQL; ordinary
legacy readers retain their prior policy. SQLite closes before the anchors.
An actual `SQLITE_BUSY` close keeps both resources pending, including in a typed
pending-owner error from convenience constructors. A consumed anchor-close
failure remains negative; closing cannot requalify the staged reader.

`MemoryStartupStore` is the separate native startup owner. Its caller holds the
actual exclusive installed lifecycle lock and has closed every other SQLite
connection to this database in the process, including idle readers/writers.
Legacy/raw writers must be quiesced at coordinated cutover. Neither sidecar
absence nor a decoded metadata record establishes that condition. The curated
application holds the lock until all actual database resources settle, closes
its connections between operations, and fences admission after uncertainty.

Preflight pins the selected database and existing sidecars before SQLite opens.
Only when journal/WAL/shm are all absent does it choose a finite main-only
immutable read; it checks the same main generation and all absences again.
An existing sidecar is never hidden by immutable mode. Existing WAL/shm use
read-only shared memory and disabled close checkpoints; unobservable recovery
states refuse before writable fallback. Matching-owner root access may still
update ctime in SQLite; generation changes conservatively refuse. Root sidecar
owner/group mismatches or set-ID bits refuse before SQLite can change them.
These observations do not promise all-root migration or metadata-inert access.
Post-observation generation checks also run after SQL refusal to report
observable stat-generation drift, including root ctime changes. They cannot
detect arbitrary mmap changes to SHM bytes. An already mapped foreign RW node
can bypass read-only-SHM behavior without changing stat timestamps; the actual
paired control remains unadmitted and the quiesced raw-byte invariant is tested
separately. Installed selection still requires the real producer to establish
the closed legacy/native resource phase; a caller flag or matching row is no
substitute for closing those actual resources.

After checked read-only closure, the same owner opens the same held source for
writing, checks its SQLite file identity and rechecks schema/metadata under
`BEGIN IMMEDIATE` before the first schema or native write. The closed versioned
`reverie_native_memory_v1` singleton stores phase and selected model separately
from generic legacy `state`. Unknown schema/rows/types/versions refuse. Without
this new owner, either historical `native_memory_*_v1` key refuses for every
value, even matching `ready`/model strings; earlier unselected marker rows are
not silently adopted or erased. A separately reviewed migration is required
for those ambiguous records. Ordinary `MemoryStore` state APIs remain intact.
Genuine native owners can repeat initialization and recover pending phases.
The format is data, never authentication, a grant or an effect/shutdown receipt.

`MemoryDocuments` implements the existing Reverie document/history/ballot tables
on the same private connection. Revisions use real SQLite writer-reserved CAS;
raw archived bodies, IDs, extra developer suffixes and tables survive. A
`RecordedBallot` is constructed only by an actual vote on that same store and
week; after reserving the SQLite writer and matching the requested revision,
the named self writer prepares its change again from the current stored body.
It checks the three-week persisted streak and exact proposal against that body,
and uses that body's persona fallback and prior belief root. A concurrent update
cannot turn a preflight no-core-change result into permission to revert its core.
The original preflight checks still precede CAS conflicts. Digests, wire fields
and booleans cannot mint a recorded ballot.
Ordinary document operations retain source Connection-context commit/rollback
semantics. The separate initial-identity CAS preserves a real outer transaction
for curated startup; it never replaces an existing self document.

The generic document `write` methods preserve trusted low-level compatibility,
including arbitrary document names. They are not an end-user permission boundary:
supported caller services must expose named plan/profile/self operations and must
not route a generic `write("self", ...)` around the self-model checks.

`atomic_immediate` reserves the writer before a startup idempotency-marker read.
It preserves named transaction methods and exposes no SQL callback. Explicit
checked connection closure remains required; dropping a handle is not a
namespace shutdown acknowledgement.

`OperationStore::into_native_start_snapshot` is a consuming fixed-purpose
reader of the exact selected PREPARED/3 or STARTING/4 operation and full current
document. Both its fresh journal lock and store close before it returns the
opaque original named stamp, retaining primary and secondary finalizer errors.
The stamp supplies data for the application's final metadata fence; it grants
no operation handle, effect permission, retry, completion or reservation credit.
