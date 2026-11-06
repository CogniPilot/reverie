# Reservation admission and observation checkpoint

This is an inactive internal application service, not the complete ReservationGate
port or a broker selector. It provides actual admission/lookup/read-side observe
over the already ported private stores, full worker validator and NativeObserver.
No request callback, serialized approval or public row/path can construct a Source,
held admission, native completion proof or start permit.

| Original method | Current Rust owner | Boundary |
| --- | --- | --- |
| constructor | `ReservationGate::new` | Consumes the real immutable validated snapshot; captures checked option/scope, pending absence and exact ordered marker data |
| `_admission_mutex`, ordinary admission | `admission` | Thread/process ownership, bounded entry wait, real nonblocking flock, operation-vs-entry bounds, checked finalizer and cleanup |
| `_guard`, ordinary path | `guard` | Actual held scope, domain/pending/image, marker and layout in source order, complete native custody, deadline then final image stamp |
| `_store`, readonly lookup | fixed weak service guard + canonical `OperationStore` | Every ordinary scope check observes native state; store and admission finalizers are checked |
| `_profile` | existing `ProfileStore::snapshot` | Real canonical flock, profile read and checked store close; never a new JSON profile schema |
| `observe` | `observation` | Current storage/start intent and full selected employee, owner/generation/profile, actual effective policy, full capacity/source/storage, exact hashes and repeated native/metadata/lock fences |
| `active_operations`, historical `completed`/pending | `history`, named contracts and fixed native readers | Validates every pending fence in source order and historical receipt/profile/verified/plan hashes before excluding a completed row; no live completion proof |
| host-job `require_idle` | `host_jobs`, named contracts/native paths | Existing settled intent, ordered original spec and fixed receipt; no owned scope or begin/bind/finish producer |
| `_retained_delta`, `check_headroom` | `history` | Actual admission, every retained source re-observed, complete capacity/inventory checks; fixed read-only INSTALL facts only |
| `reserve`, `_observe_claim` | `claim`, fixed private `ClaimCapacity`, canonical `confirm_claim` | Actual durable metadata claim and selected profile/target checks; installed observer runs under journal flock; public reserve discards effect handles |
| `_finish_claim` | `terminal_claim`, consumed exact store reader | Fresh terminal reader/store/lock close before last native guards; metadata/preview close their original store too, while the retained producer keeps its actual original store; full epoch/source/metadata fences and named journal stamp |
| `cold_inspect`, `check_recovery` | `recovery` | Fresh matching/changed/unavailable source facts and unchanged journal; no handle resurrection, retry or positive capacity credit |
| preparation `draft` for an already selected profile | `draft`, fixed `DraftCapacity` and named draft codec | Actual journal flock around observe/retained headroom; only then allocates opaque IDs, checks all occupied roles, closes store, bounds every directory entry and exclusively persists/fsyncs the fixed draft |
| preparation `reserve`, `_RetainedClaim` | `preparation`, shared `claim` owner | Reuses exact approved IDs, real process-local journal handle and owned store, original canonical profile/context and exact source paths; replays cannot manufacture a handle |
| native `capture_original`, `_account_mounts` | `preparation`, fixed `reservation_kernel` and named baseline codec | Actual selected source limits/storage/capacity hashes, physical cgroup identity, ordered source resolves/identities then sorted account references and fixed proc-root identities; no credential contents read |
| `begin_prepare`, `_finish_phase` before publication | `preparation_phase`, retained handle, fixed publication codec/reader/writer | Latches before admission, durably records PREPARING before intent publication, preserves fresh-thread recipe semantics and original source/epoch/storage; exact selected operation and named journal/phase stamps fence the terminal result |
| `confirm_publication`, `_finish_phase` after publication | same retained phase owner | Observes the normal server's exact intended employee rebind and unchanged storage identity; never writes that company row or acknowledges prepared/CLI/start state |

The waiting-state mutex is never held through filesystem I/O. A private entering
registration keeps other threads' waits bounded before the flock open returns;
it is not held admission. Admission frames are non-Send. Body errors skip success
native finalization, matching the original context manager, but still close every
owned store/lock. Stable guard error codes retain their complete source errors
and publicly inspectable secondary finalizer failures.

The ordinary guard currently refuses every control transition marker. It does not claim
the unported GPU/actor/image/perf/mount transition owners or their pending/row
exceptions. RAM profile selection, configuration staging/commit/reload,
creation/stop policies, start/completion boundaries and host-job begin/bind/finish remain
required. These must be real producers before a full Gate or launch claim. Caller
owner/session authorization and future selected HTTP/broker integration remain
separate obligations; captured worker/path data never supplies those permissions.

Named observation data retains nil profile EID/SID values until the existing
journal role decoder checks nonnil IDs at its actual claim boundary. CPU numeric
ceiling/equality is separate from encoding-sensitive profile/policy digests. The
original employee row and native dictionary values are copied losslessly; only
the already closed ASCII profile schema is encoded/decoded through its one codec.

One actual old `ReservationGate.observe` oracle uses real owned private control,
company and profile files with explicitly fake engine/kernel facts. Its canonical
observation, source-binding template and pool-epoch bytes/hashes match Rust.
This is workflow/data compatibility, not installed kernel or effect qualification.
Five hundred frozen actual Python CPU witnesses check nano-CPU arithmetic, and
drift/CPU-kind, body-error, wrong-thread, lock-open and pre-open waiter regressions
exercise the native/store composition. No company instance file, engine operation,
mount, employee start/stop or live deployment is performed.

The historical successor freezes 32 actual old host-job idle cases, 33 completed
receipt cases and 14 pending cases using owned metadata/path fixtures. It retains
Python dictionary numeric equality and codepoints without interpreting receipts
as execution authority. Pending enumeration drains all entries/errors and closes
the directory before metadata reads, retaining a bounded native-order prefix
through entry 4097; every earlier file is checked before the count refusal.
Real admission/journal integration verifies headroom, orphan fencing, retained
source loss, the 4096/4097 boundary and checked enumeration finalizer failures.

Claim regressions use actual private journal/flock files and controlled native
observations to test reserve/replay, pre-publication target and snapshot refusal,
durable publication followed by response loss, and cold matches/changed/unavailable
states. A terminal native hook observes both actual journal descriptors closed,
then changes the named journal generation; the response remains uncertain and
retains the positive claim. No retained preparation handle or live effect is
exposed by the public metadata entry.

The separate `retain_draft` entry now produces an actual nonserializable retained
preparation owner, after original native capture and terminal admission checks.
Its data getters cannot grant native effects. It keeps its original journal
store/handle until checked close; the fresh exact terminal reader and lock close
before terminal native observations. Closing/dropping never clears the durable
claim, credits capacity, grants retry or acknowledges completion. The immutable
captured config cannot substitute for the still-required mutable broker reload
owner. No start/stop/configuration-commit method is exposed by this cohort.

Two frozen actual old Python draft records verify exact bytes/hashes, including
a nil current SID that previews successfully but cannot enter a journal claim.
Real journal/flock tests check locked observation and close ordering. Private
draft profile comparison preserves Python numeric equality (including bool/zero
and signed zero); it always retains the actual checked canonical profile.
Malformed numeric request spellings are checked at the original later phase,
after earlier admission/native reads, and mismatched stored target/profile
bindings fail before live profile I/O. Native baseline loss after publication
retains the positive claim and closes owned descriptors without a fresh handle.
The native account tests use owned fake-kernel trees and actual directory
identities, source-first failures, raw trailing-dot behavior and namespace drift.

The phase owner now has a real one-attempt PREPARING producer and readonly
publication observation. Every error after the attempt closes its original
store, keeps the durable claim and forbids reuse; no rollback or synthetic ACK
is supplied. Fixed draft/publication writers share one private exclusive-file
and checked-finalizer owner, with no public raw path/bytes editor. The terminal
phase reader permits unrelated valid journal rows while requiring the entire
selected operation and allowed phase to match. No engine/kernel producer runs
after its final journal/phase metadata stamps.

Twenty-two frozen actual old `begin_prepare` cases check recipe mode, disabled
and missing nested data, fresh thread bookkeeping and lossless unknown fields.
An actual old raw-surrogate witness confirms that copying must retain distinct
unescaped codepoints even when the later escaped receipt reload changes them;
that mismatch remains an uncertain PREPARING claim. Actual workflow regressions
also cover lost transition ACK, retained exclusive names, premature publication,
last-stamp drift, and fresh reader close ordering. These checks qualify source
compatibility only, not a mutable broker reload, protected stop or launch.
