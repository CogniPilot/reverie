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
| `_finish_claim` | `terminal_claim`, consumed exact store reader | Both stores/reader lock close before last native guards; full epoch/source/metadata fences and named journal stamp; uncertainty retains durable claims |
| `cold_inspect`, `check_recovery` | `recovery` | Fresh matching/changed/unavailable source facts and unchanged journal; no handle resurrection, retry or positive capacity credit |

The waiting-state mutex is never held through filesystem I/O. A private entering
registration keeps other threads' waits bounded before the flock open returns;
it is not held admission. Admission frames are non-Send. Body errors skip success
native finalization, matching the original context manager, but still close every
owned store/lock. Stable guard error codes retain their complete source errors
and publicly inspectable secondary finalizer failures.

The ordinary guard currently refuses every control transition marker. It does not claim
the unported GPU/actor/image/perf/mount transition owners or their pending/row
exceptions. Retained preparation ownership, creation/stop/reload policies,
preparation/start/completion boundaries and host-job begin/bind/finish remain
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
