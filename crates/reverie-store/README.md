# Reverie profile store

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
