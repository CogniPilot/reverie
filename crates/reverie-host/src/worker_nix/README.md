# Private Nix store preparation

The session guard owns the actual Nix flock until helper settlement and real
container creation. Its raw captured configuration remains separate from the
effective configuration resolved after guard acquisition. Image and resource
refreshes are accepted within the same immutable service and storage namespace.
Employee storage is the actual `LaunchStorage` resource; legacy sessions retain
their real unleased paths. A path, label, SID or preparation status supplies no
owner permission, admission, writer exclusion or laptop start grant.

`WorkerRuntime::retain_nix_store` moves both real resource owners into a bounded
service record before any engine call. The broker can replace its direct owner
with the returned same-record handle under its registry lock, run outside that
lock, and reclaim the exact owners once after confirmed settlement. Unknown
create replies, removal failures and native finalizer uncertainty keep the
owners and helper turn. No create, start or uncertain removal is replayed.

Legacy image opt-out precedes fresh guard/storage checks and never waits for a
different helper's copy. Enabled preparation retains original prefix ordering,
then begins its 300-second budget and global helper serialization. Logs and
removal each have their separate source 20-second client budget. The first
service stop clamps every subsequent client and settlement to the same
34-second deadline. Close requests that stop, drains actual records, then seals
the same captured client. Explicit global settlement always attempts that
client's actual native job and every retained record even when a different
helper remains unknown; typed primary and secondary failures are preserved.
Per-record cleanup alone settles only its exact call and cannot cancel another
query. Admission is permanently sealed only after those owners confirm cleanup.
Returned owners and unrelated process contexts remain
the installing broker's responsibility; closing this runtime is not a global
storage release acknowledgement.

The shared client keeps registration input in its tracked process before any
late constructor. Its private typed descriptor is reserved above stdio, copied
to child stdin, and closed once in child and parent with failure checking.
Only the fixed guest bootstrap retains raw progress tails: at most 65,539 bytes
per channel, including a valid UTF-8 scalar crossing the cut. Invalid bytes stay
raw, child status is independent of delivery, and metadata/journal clients keep
their original null stdin, strict UTF-8 and combined 4 MiB output limit. The
installed guest is one-shot for the process lifetime, including terminal
failure. Its programs and `/etc`, `/tmp`, `/target` paths have no runtime
override. Diagnostics follow settlement, use the shared bounded transport and
stop on the first incomplete attempt. There is no hard bound on kernel or
filesystem latency; a blocked record remains retained.

The original unpatched guard/selection code and Bash recipe supply the fixture
oracles. The explicit installed qualification imports a real immutable Nix
registration, copies offline into owned temporary stores, verifies preserved
old registrations/profiles and bytes, and checks the updated image GC root.
It requires compile-bound artifacts and is ignored by the default gate. No test
starts an actual container, mounts a filesystem or edits live company data.

Two preservation corrections are deliberate: an observed employee/storage rebind
during the enabled prefix refuses before create, and diagnostic logs refuse foreign
inodes/hardlinks/FIFOs before truncation. The original hardlink witness damages
the other owner file; the native paired test preserves it and still removes the
helper exactly once. A held/named inode check is a race observation, not an
atomic exclusion of later same-UID links or replacements. Actual lifecycle
writer exclusion remains required. Failed guest GC-root replacement retains
temporary evidence instead of deleting a name that may have been rebound.

Common-client contention does not mean a helper call was dispatched. A cleanup
intention retains its original 20-second admission/execution deadline across
Busy responses and caller settlement ceilings. Only the exact call minted by
the controller's locked admission consumes the one dispatch. Unknown dispatched
work is settled through that call's identity, never a different active query;
an expired unsubmitted removal leaves the helper and its resource owners
retained. Actual owned competing-client tests cover both first admission after
Busy and expiry with zero removal dispatches.
Unknown create/removal controls also retain a real employee flock across both
current and historical transports, even after caller workflow handles drop.

RAM retention does not survive a service crash. Restart requires the actual
writer census, source fences and fixed prior-helper checks. The real broker's
post-copy generation/policy/intent/storage checks and qualified laptop creation
remain separate consuming phases. Neither test records nor `Prepared` mint
their permissions.

Active Python consumers remain migration debt: `worker.py` uses the guard and
preparation; `employee_laptop_migrate.py` and `worker_nix_migrate.py` use offline
guard paths; `worker_store_maintenance.py` uses selection and helper arguments.
Those entry points must migrate before deleting their shared Python module.
The native guest package is a candidate until image/source consumers qualify;
there is no Python fallback within it.
