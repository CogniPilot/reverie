# Docker-contained employee continuation

This application service prepares an explicitly approved new Docker destination
for a stopped employee laptop whose old placement cannot meet the selected
Docker resource policy. The old container stays stopped and unchanged. The
employee ID, full session ID, logical generation, provider conversation, account
selection and actual private HOME/Nix directories remain selected originals.

The controlplane selects the explicit backend `REVERIE_RUNTIME_BACKEND=boxed-docker-v1`
and a read-only fixed `/etc/reverie/boxed-runtime.json` manifest. The schema binds
one deployment, qualified worker image, client-capsule manifest, accepted source
images, resource-helper image and API URL. Native worker socket selectors cannot
be combined with this backend. Only the controlplane receives the fixed Docker
engine socket. Workers and resource/storage helpers receive no engine socket.

The fixed container-owned data directory initializes and retains a private
callback key. Its directory and key descriptors remain open; replacement or
permission drift revokes it. A callback token establishes one selected worker
identity, independently of CompanyService permissions. Existing scoped recovery
and office permissions remain necessary. An agent cannot approve resource edits.
The currently qualified callback adapter supports single-user instances.

A verified owner can review an optional legacy desired-policy DATA proposal and
approve policy together with recover-and-enter-office in one request. An absent
legacy mount supplies no defaults or authority. Generic employee updates cannot
edit Docker policy or bindings. The native CLI commands and thin profile GUI use
the same application decision owner and retained request; pending and held
outcomes remain visible. CLI exit zero means ready, not merely HTTP success.

The canonical CompanyStore records the operation before effects, helper creation
intent before CREATE, and actual container IDs before START. Observation can
inspect the original effects and finish their metadata, but cannot create/start
helpers, configure resources, write credentials or launch providers. A fresh
protected effect request can advance a helper known to be created but not yet
started. An unknown create/start or missing/failed helper acknowledgment never
becomes permission to repeat an effect. The one exception is the leaf resource
writer, described under "Leaf resource writer retry" below: a writer proved
terminal and failed is never started again, but may be followed by a new attempt
with its own journal intent.

## Leaf resource writer retry

`configure-high` reads every thread of every laptop in the box several times.
A thread that ends between two of those reads once ended the helper with an
error after its first write, and the operation then held for good: the journal
had no phase after `start-issued` except a success acknowledgement.

The helper task journal now has a terminal `failed` phase for the leaf writer.
It records the exact container, its exit status and one of five failure classes
(`lost-process`, `deadline`, `refused`, `close-unconfirmed`, `unknown`). The
class is read from the one line the helper printed through a closed allow-list;
the line itself is never returned, logged or stored. Records written before this
phase existed read unchanged, and a first attempt keeps its earlier name.

A rerun is a new task: the next attempt index, a different container name, its
own `create-issued` intent, and arguments built from a freshly collected scope.
It is issued only when all of the following hold, and otherwise the operation
holds with a code, a sentence and its allowed actions:

1. The failure class is `lost-process` or `deadline`. A refusal of identity or
   policy, a lost close and anything unrecognized are never rerun.
2. The failed writer is the exact fixed container of the journaled task, exited
   with a nonzero status, not running, PID 0, not paused, restarting or dead, and
   unchanged across two inspections around a fresh read of the same leaf.
3. The operation is still at `resources-issued` with the same anchor, worker,
   leaf and policy the failed writer was issued for, and no soft-memory revision
   exists for it.
4. Every leaf writer container of the box that targets this worker is terminal
   under its own fixed configuration, before and after the proof in 2.
5. Fewer than three writers were issued by this request, and fewer than nine by
   the operation.

One request issues at most three writers. After that the hold offers `retry`
(the same request again: Continue for a laptop recovery, Continue for a plan
move) and `rebuild-preview` (Rebuild laptop). After nine writers, or for a
failure that is never rerun, it offers only the rebuild. A plan move held this
way keeps its own `continue-original` and `abandon` actions; continuing first
records the failure during its read-only inspection and then reruns the writer.

An acknowledged writer is recorded without its attempt index, in exactly the
shape a first attempt always had, so an office image that predates the rerun
reads every finished operation. A record that holds a `failed` task or an open
later attempt is not readable by such an image, and that record is part of the
whole company file or plan-move journal. Do not return to an earlier office
image while any operation is in that state; let it finish or rebuild the laptop
first.

Matching kernel values still never replace an acknowledgement. A rerun earns a
real one: the helper's own exit 0 and readback. Settling a failed writer by
observation alone, without a rerun, is not implemented.

A pool writer that exited with an error is recorded as failed in the same way
when the request is sent again. It acknowledges nothing and is no unknown
write. The attempt after it is issued from a freshly read pool: the
operation's own `configure-pool` for an empty pool, the restore helper for a
pool other laptops already run in. An acknowledged pool writer is never issued
again; its acknowledgement is shared by every laptop of the box through the
retained pool lineage. Limits that a reload of the host's service manager
reset are put back in place by their own repair, described under
[owner operations](owner-operations.md#put-approved-limits-back-after-a-reload-of-the-host-service-manager).

### Separately pinned leaf writer image

`helperImageId` pins the anchor, the probes that run inside it, storage holders,
the pool writer and every existing acknowledgement. Changing it makes every
existing box unreadable, so a corrected helper cannot ship that way. The
optional `leafWriterHelperImageId` selects the image for NEW `configure-high`
leaf writers only, in the same way `memoryHighHelperImageId` and
`poolRestoreHelperImageId` select their writers. A journaled writer is always
read under the image it was issued with, so writers issued under the baseline
image stay acknowledged after the pin is selected. The image must carry exactly
the baseline label set (build `docker-leaf-writer-helper-image`): a created
container inherits its image's labels, and the fixed leaf writer configuration
has the purpose label alone. A selected image that the Engine cannot supply is
refused before any intent; there is no fallback to the baseline image. The same
image is used for `restore-high`, which re-applies a running laptop's approved
limits in place, so a selected image must be a build that carries that command.

Probes keep running the binary inside the existing anchor. They are read-only
and the office already repeats a probe that lost a process.

Resource acceptance requires the same actual helper's successful completion and
fresh kernel observations. Docker hard memory, no-swap/PIDs, aggregate pool,
cpu.weight/cpuset and finite memory.high are separate checks. MemoryReservation
is not memory.high. A read-only storage holder retains original directory FDs
across host pathname replacement, and the actual destination must match those
held directories before provider startup. Paths and serialized IDs are only
correlation data.

The existing Session/mux services render the selected provider recipe. A private
one-attempt owner admits its first launch; saved Docker metadata can only attach
to an already-running matching provider. The fixed client capsule and managed
callbacks live outside private /nix. No shared Basic or hook secret is provisioned.

## Remaining integration and acceptance gates

### Automatic recovery after a reboot

The running office periodically compares each desired employee with its current
session and binding. A missing or revoked viewer can be attached to the verified
original provider. Returning from vacation or completing a pending original
operation makes the employee eligible on the next pass. Operator wake and the
periodic check use the same attachment service.

The first failed attachment is retried on the next ten-second check. Repeated
failures with the same reason double the interval up to two minutes. Each
employee has an independent interval. An explicit restore, a newly observed
resource change, or a new session binding can trigger an earlier check.

Same-plan recovery now checks the stopped worker’s HOME and Nix mounts before
reserving a move. Linux can assign a different device number to the same ext4
filesystem after a reboot. Legacy storage receipts identify a directory by its
device number, inode, ownership and mode. When the device number changes, a
stopped worker with only that receipt can remain held. Retrying its move cannot
supply the missing filesystem identity. A durable replacement receipt needs a
stable filesystem identifier for each mount as well as the original directory
identity. Reboot qualification must cover both device renumbering on the same
filesystem and a different filesystem mounted at the same path with matching
inode numbers. For legacy receipts on one ext4 filesystem, the signed-in owner can approve a
verified device renumbering through
`POST /api/company/employees/:id/docker-storage/device-approval`. Compare the
pre-reboot mount inventory and kernel filesystem UUID with the current mounts
before approval. The request selects the original session, generation, operation
and container, both original directory inodes, the old and current device
numbers, and the current kernel filesystem ID (unsigned decimal). The kernel
filesystem ID is distinct from the ext4 UUID. The Rust verifier checks this ID
on both read-only directory descriptors on each of the two reference reads.
Ownership, mode and inode checks still apply. Approval lasts for this office
process and applies only to the selected placement. A stopped source or an
existing held move uses its ordinary owner recovery workflow after approval.

The office now supplies the stable filesystem identifier itself, so the
approval is no longer the only way past a renumbering. The verifier has a
read-only command, `observe-storage-reference`, that reports the identity of
the two reference mounts and of the filesystem each is on. While a finished
laptop runs, the office records the filesystem ID of its two directories in
`docker-storage-identity.jsonl`, only when the verifier sees exactly the
directories the laptop itself reports, on one ext4 filesystem. For a stopped
laptop whose mounts no longer match the holder's receipt, the office reads what
is mounted now and proposes the renumbered reference to the verifier by itself
when both directories are otherwise unchanged and either that record matches or
the owner's standing grant (company setting `acceptStorageRenumbering`) covers
it. The verifier then checks that reference, with the filesystem ID, on both
reads, as it does for an approval. Another inode, owner or mode, a filesystem
that is not ext4 and directories on two filesystems are never proposed. A
verifier image that predates the command can only compare: an unchanged device
verifies, and a changed one is refused and needs the approval, because the
office cannot read whether only the device number changed. The office probes
the configured image for the command once at start and says what it found. A
run of the verifier is given thirty seconds and a read is tried twice; a read
that gave no answer is reported as such, with its cause, and is never taken
for a confirmed home. The standing grant applies only where the office holds no
record of the employee's storage. See
[owner operations](owner-operations.md#the-stored-home-of-a-stopped-laptop) for
what the supervisor does with each finding.

A cold recovery of the shared pool admits a stopped anchor however it ended,
refuses a dead one with `DOCKER_POOL_COLD_ANCHOR_DEAD` and any other state with
`DOCKER_POOL_COLD_ANCHOR_NOT_STOPPED`. A pool writer that no record names as
finished is admitted when it is of a configured image, fixed, and either never
started or ended, the same across two inspections: it can write nothing more to
a pool whose anchor is stopped. A pool observation admits a writer that was
created and never started as a closed writer, never as an acknowledgement. In
every read of the laptops of a box, a laptop on record that the Engine
positively reports absent, by an exact-ID census, runs nothing; one that is
listed and cannot be inspected still stops the read. Besides the laptops on
record, the cold recovery asks the Engine for every container with the box's
laptop label (`reverie.boxed.box`) that is running, paused or restarting, and
refuses with `DOCKER_POOL_COLD_WORKERS_RUNNING` while there is one.

The office also recovers the shared pool and brings every employee back after a
host restart without the owner, through the existing cold recovery, rebuild and
set-up services; see
[owner operations](owner-operations.md#after-a-host-restart). That is the path
in use today. The durable operation below, which would restart a stopped laptop
in place instead of rebuilding it, is still not implemented.

Cold recovery still needs a durable Rust operation with the following behavior.

1. Read the current desired state, session generation, account, provider thread
   and storage binding. A vacation, revoked approval or superseding generation
   ends eligibility. Group employees by their approved pool so one operation
   restores and verifies the shared anchor.
2. Find or create one recovery journal for the employee, generation, original
   container and failed incarnation. Concurrent wake requests and office
   restarts must join that operation. A running provider goes through ordinary
   viewer attachment.
3. For a verified stopped container, start only its inert init. Recheck its
   actual storage and apply and read back its approved cgroup limits for the
   new incarnation before enabling provider work.
4. Record the intent to resume the original thread before dispatch. If the
   office exits between dispatch and acknowledgment, inspect the original
   operation and provider. A second dispatch requires proof the first could
   never have started. An unknown thread requires an owner decision.
5. Report working only after the bound provider and terminal are both ready.
   Persist the pending reason, last observation and next retry time for the GUI
   and headless clients. Back off transient observations independently per
   employee so one unavailable account cannot delay the fleet.

Qualification requires a real reboot, a concurrent manual wake and automatic
tick, and an office crash at each effect boundary. Verify one pool restore, at
most one provider dispatch per incarnation, the original thread and storage,
and a usable terminal for each eligible employee.

Source tests do not qualify an installed employee. The composed image, actual
PTY-to-fixed-engine path, provider command, bound callback transport and
owner-authenticated workflow need separate installed qualification. Normal wake
can attach to a freshly verified running boxed provider. Restarting a stopped
destination/provider after a host reboot needs a distinct retained effect
continuation; it does not fall back to local/native execution. Fresh employee
creation and successful plan moves with boxed bindings remain separate owning
work, alongside the full company/plan/permission CI scenario. This slice is not a
claim that those workflows are complete.

### Recorded containers that no longer exist

Every continuation step re-inspects the original or the destination. When an
operator prune removed them, the record cannot advance and `begin` refuses a
new operation while it exists. The owner workflow
[Reprovision a laptop whose containers are absent](owner-operations.md#reprovision-a-laptop-whose-containers-are-absent)
handles exactly that case.

It requires a positive Engine listing that none of the recorded containers and
no container labelled for the employee exists. It then retires the record and
binding into `retiredDockerEmployeeContinuations`, removes the saved session's
stale boxed view and boxed launch denial, and creates one stopped replacement
source from the retired record's HOME bind, its sibling Nix directory and an
owner-approved shared-drive template. The source carries the ordinary
`reverie.worker`, `reverie.employee` and `reverie.session` labels, so
`GET …/docker-policy` selects it and `POST …/docker-continuation` begins a new
version 2 operation with a new operation ID. Storage holder, pool, destination,
start, resources, identity and provider launch are unchanged; the launch
resumes the saved conversation.

The source's only network is the employee's surviving per-worker office API
bridge, which the destination copies as its `NetworkMode`. The pruned
per-laptop source bridge is not recreated. A retired plan replacement (version
3) record becomes history; its open native move is closed as abandoned in the
PlanMoves journal and the new operation is an ordinary version 2 continuation.

The source also carries the employee's provider account routing, derived by the
backend: a retired plan replacement keeps its in-home account generation as one
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` entry, and a saved launch override that
selects the employee's own subscription seat gets that seat as one read-write
bind at `/instances/default/console/accounts/<id>`. The destination copies both
from the source.

A source that was never started can be replaced under a new operation ID. The
same workflow also supersedes a version 2 record that was begun from that
source and never requested a destination. A record at `destination-issued` or
later is not accepted. The record's storage holder is left in place.

The workflow does not start containers, launch providers or create a fresh
employee. A laptop with any surviving recorded container stays with the
workflows above.
