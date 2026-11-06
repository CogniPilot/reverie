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
| terminal readonly journal seam | existing consumed store reader | Available dependency only; not yet integrated into a completed claim workflow |

The waiting-state mutex is never held through filesystem I/O. A private entering
registration keeps other threads' waits bounded before the flock open returns;
it is not held admission. Admission frames are non-Send. Body errors skip success
native finalization, matching the original context manager, but still close every
owned store/lock. Stable guard error codes retain their complete source errors
and publicly inspectable secondary finalizer failures.

The ordinary guard currently refuses every pending marker. It does not claim
the unported GPU/actor/image/perf/mount transition owners or their pending/row
exceptions. Preparation/start/completion boundaries, approved-claim target checks,
claim retention/terminal finish, recovery/headroom/creation/stop/reload policies,
host-job begin/bind/finish and historical completed/pending rule owners remain
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
