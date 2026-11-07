# Reservation observer compatibility boundary

The source owner is the complete `NativeObserver` class in
`python/reverie/worker_resource_reservations.py` at `f047ba67`, plus the complete
`worker_capacity_policy.py` predicates and `worker_memory.check_swap_budget`.
This service returns read-side facts. No product transport selects it yet, and
no launch/admission, reservation credit, journal transition, private control-file
publication or storage lease is implemented here.

| Source method | Rust owner and preserved checks |
| --- | --- |
| `_deadline` | A lexical captured context replaces mutable thread-local state. Typed monotonic deadlines take the minimum of 30 seconds, the inherited operation bound and any supplied bound. Nested queries share the same bound. |
| `host_root` | Fixed host kernel adapter: full mount table, exact root mount/type, absent root current counters, both controllers, readable observer counters, exact RAM accounting and membership recheck. Missing hierarchy facts never imply free capacity. |
| `inventory` | Application issues only fixed ps/inspect queries. Each batch's count and JSON parse completes before the next native query; global row/ID checks precede source-order mount sorting. All unknown row/mount fields and duplicate mount records survive. |
| `stopped_state` | The named pure preflight runs before InspectStopped. Fresh extended state is joined to the unchanged ordinary projection; unknown Status/StartedAt values remain data. |
| `custody` | Complete mount table and engine inventory precede the scan; both are reobserved afterward. Lexical/resolved overlaps, exact future marker coordinates, same-device aliases and nested mount roots all refuse exposure. |
| `limits` | Existing `resource_staging::effective_config` is reused, including the source's separate second resolution for the policy hash. Kernel reads bracket the original PID and cgroup membership and qualify every ancestor. Exact leaf memory/swap/PID limits and applicable high/swap ancestry remain required. |
| `stopped_website_limits` | The pure data owner checks stopped state, absent worker labels, exact finite declared RAM/swap and bounded tasks. It does not assert a running kernel limit. |
| `capacity` / `_capacity` | Exactly one configured website; all running workers, including other deployments, contribute freshly qualified commitments. Explicit host and pool predicates are mandatory; the legacy 90% fallback is not selected. |
| `capacity_stopped_website` | A checked complete container ID selects the stopped website declaration; every running worker still needs its kernel observations. |
| swap budget | Every running worker's finite RAM/swap declaration contributes. Configured pool and actual fixed host SwapTotal are separate bounds; malformed versus absent/duplicate capacity has its original rule owner. |
| `storage` | Exact single writable bind source for each destination, original codepoint spelling, configured UID, all four device/inode/UID/GID fields, process-visible identity, source recheck and PID bracket. |

Core owns arbitrary unsigned arithmetic and checked capacity rules. Contracts
own exact lossless JSON, complete rows, canonical fingerprints and kernel text
formats. Host owns kernel/filesystem and supervised engine observations. The
application owns sequencing, one configuration snapshot and census provenance.
Shared JSON parser purposes remain separate; the incremental inventory decoder
does not introduce a generic parser policy or native callback.

The persistent `ReadonlyEngine` retains its owned process/pipe cleanup state
after uncertain results. The installing service must retain this observer and
check `settle_owned` before acknowledging shutdown. Cleanup never changes a
failed query into successful observation or admission, and no query is retried
implicitly. Cancellation is one-way and observed between bounded reads/queries.
The engine adapter owns its per-command 20-second clamp, output bound and exact
owned-client signal/reap behavior. Filesystem syscalls retain ordinary operating
system scheduling; checking a deadline does not claim they are preemptible.

Native kernel reads are bounded and descriptors are explicitly finalized. Swap
meminfo uses the fixed bounded kernel reader rather than allocating unbounded
text. This has no request-selected source or bypass. The private fixture source
uses owned files and synthetic mount namespaces, never a production override.
The explicit ignored host-root qualification reads only installed proc/cgroup
facts; it performs no engine query or company-data read.

The existing worker identity adapter keeps its strict canonical storage-path
contract: spelling such as a state root ending `//./` is rejected by both old
storage/effective-config paths. The separate storage text view normalizes only
when deriving Python Path suffixes, verifies identical native bytes, and keeps
untouched codepoints instead of fsdecoding them into a different string.

These snapshots need fresh binding inside the eventual admitted broker effect
workflow. They are not PID ownership, owner authorization, storage start
eligibility, a capacity reservation, native operation completion or evidence
that the Python broker has been removed.
