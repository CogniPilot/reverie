# Native storage lifetime

`StorageLease::acquire_launch` and the named offline `acquire_migration` retain
the actual nonblocking `flock` on the stable employee/session lock. Both use
the existing company, lineage, path and identifier owners. Migration skips only
the fence check. Canonical nil session UUIDs and Python owner codepoints remain
data; labels, request employee IDs and retired intent never mint a lease.

`prepare_storage` preserves paired home/Nix migration refusal, the related-edge
plan journal, ready-marker equality and single-directory creation order.
`record_storage_binding` allows current OFF employees, refuses historical-only
bindings, and writes the existing ASCII, sorted, spaced JSON without overwrite.
`validate_storage` is a separate read-only restart snapshot check; `lock_paths`
returns existing fixed-path data. Neither acquires admission or initializes data.
Unrelated resource maps are not validated. The installing broker supplies its
captured worker configuration (including its already checked UID/path shapes);
the lease retains that snapshot while every actual registry read is fresh.

The broker must retain the lease for the **laptop lifetime**, not a terminal
viewer lifetime, and inspect actual running-container writers on acquisition
and recovery. Another process retaining a running writer after broker-FD loss
is not excluded by flock alone. This module does not construct a start permit,
adopt a container, authorize a migration, or release a Gate operation.

Private directories preserve the source predicate (owned, directory,
`mode & 077 == 0`), including owner-only modes other than0700. Ancestors require
ordinary OS search permission, not a new root/owner policy. Search-only anchors
avoid requiring read permission until the source's actual parent-fsync phase.
All traversal/open operations refuse symlink substitution and use atomic
CLOEXEC; lock opens additionally use NONBLOCK so an invalid FIFO cannot block
before type validation. This is a narrow defensive refinement for invalid lock
files. No stronger inactive option/resource validation is introduced.

Held directory and lock descriptors prevent inode reuse during identity checks.
Creates target the held parent; named directory/leaf checks reject observed
rebinding, and foreign leaves are never removed. These checks do not make a
path globally immutable against a noncooperating same-UID writer. The original
private-directory/cooperating-flock boundary still applies. No filesystem call
is claimed to have a hard kernel/disk latency bound.

Directory, lock, marker and lineage effects are retained after failure.
`PartialEffects` conservatively records that mutation may have occurred; no
rollback, automatic effect retry or unchanged-filesystem receipt is returned.
Marker publication remains the source's exclusive direct write, not a new
rename protocol. Writer fsync, checked close and directory fsync must all
succeed. Primary and checked-finalizer failures are preserved together. Checked
consuming `close` is required; ordinary Drop is best effort and cannot acknowledge
release. A failed close consumes its descriptor once, never retries a possibly
reused numeric FD, and requires the caller to fence/reconcile the unconfirmed
outcome.

The58 actual unmodified Python3.13 recipes compare acceptance and full retained
tree paths/modes/bytes, including all nine related plan phases, owner surrogate
text, numeric ready-marker equality, missing paired directories, dangling links,
historical/current lineage and owner-only permissions. Rust controls additionally
exercise real flock exclusion, nil ad-hoc sessions, lock symlink/hardlink/FIFO,
directory/leaf rebinding, checked close and dual-failure retention. The fixture
records interpreter and original module SHA; production uses no Python process.

Remaining integration belongs to the real installing broker (claim/recovery,
writer inventory, engine effects, lifetime retention and release). Other Python
consumers of these rules include `worker_nix`, `worker_storage_labels`,
`employee_laptop_migrate`, store maintenance, provider health and service upgrades.
Their control workflows are not ported merely by this module. Command telemetry
and the worker runtime-directory callsite still need their named resource owner;
there is deliberately no public arbitrary-path mkdir/write interface here.
