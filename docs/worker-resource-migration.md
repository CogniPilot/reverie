# Staged laptop resource policies

A resource-policy change must preserve access to existing laptop programs and
scoped office APIs. Changing a global policy and restarting the broker can leave
running programs intact while making every terminal reattachment fail its grant
check. A healthy broker socket or a count of running containers is insufficient
acceptance evidence.

The optional owner-only `sessionResources` configuration map gives a selected
session an effective resource policy. Each entry contains exactly `budgetMode`,
`memoryMiB`, `pidsLimit`, `cpus`, `poolMemoryMiB` and `poolTasksMax`. It cannot change
mounts, account paths, device grants, identities, images, commands or credentials.
The map is stored in the private host broker configuration, never accepted from a
laptop launch request. Omitted sessions retain their existing global policy and
policy digest. Container creation uses the selected session's effective policy.

The host-only `reload-resources` control loads validated resource changes without
restarting the broker or closing its terminal connections and scoped office
proxies. It refuses non-resource changes. It also checks every tracked running
container's deployment, session and effective policy label: a live laptop whose
policy would change must first be checkpointed and explicitly stopped. This
control is unavailable to a laptop caller, including a website maintainer.

## Migration sequence and acceptance

This is a source feature requiring independent review and real host acceptance;
its availability in source is not activation approval. Install the reviewed broker
code first using the project's own flake. If that initial service upgrade requires
a broker restart, explicitly coordinate the transport interruption and normal API
reattachment while retaining the unchanged admission configuration. Prove all
existing terminals, provider programs and scoped office APIs are healthy before
starting a canary. Do not confuse an outer transport exit with provider exit.

Keep admission as the default during migration. Checkpoint one desired-running,
non-vacation session, verify its current employee binding and exact deployment
container ID, then stop only that selected laptop. Stage its complete six-field
resource override in a private candidate, validate the whole configuration and
atomically replace the live file immediately before owner `reload-resources`.
If reload refuses, restore the exact prior bytes; do not restart the broker or
blindly retry. Existing terminal/API connections remain in place. Wake that same
employee normally, then verify its program, scoped API, effective individual caps
and actual host cgroup parent. Simultaneously prove an unchanged legacy session's
terminal and scoped API continue working.

A finite pool plus bounded laptops outside it reserve separate RAM. New pool
creation checks actual running deployment containers and their host cgroups.
Outside-pool laptops need finite RAM caps and no swap; the sum of those ceilings,
the actual pool ceiling and an eight-GiB reserve must fit within 90% of host RAM.
New bounded admission workers are included in this check while the fleet is mixed.
Do not enable a full 48-GiB pool alongside approximately 40 GiB of legacy caps on a
64-GiB host. Start with a smaller finite pool, accounting for all remaining legacy
ceilings, and grow it only as confirmed-idle sessions migrate. No occupied slice
may be stopped; reducing an occupied cap also needs a separate usage/headroom
check and owner coordination.

Every creation and recreation rechecks actual running peer ceilings and worker
capacity before stopping, removing or creating a container. Only the selected
target's prior reservation is replaced; tracking a stopped session does not exempt
its replacement from admission. Missing or unbounded outside-pool peer ceilings
refuse admission. New pool worker admission also requires finite pool limits and task headroom. Reattaching
an existing pool worker still requires the finite pool protection but does not
reserve tasks for another program. Missing or unlimited pool protection refuses
new unlimited workers. An admission laptop reattachment does not need a pool.

After every running laptop has the desired pool policy, the owner may make that
policy the global default and remove redundant session overrides. Reload verifies
that this does not change a running laptop's effective policy. Do not regenerate
broker configuration with `prepare` during migration; retain the private resource
map until migration or rollback is complete.

## Rollback

During a partial migration, keep the pool overrides for migrated running laptops
and admission defaults for unchanged ones. Restoring old global JSON alone strands
one of the groups. Retain the finite protective slice, checkpoint a selected
session, explicitly stop it, remove its pool override through validated resource
reload, then recreate it under admission. Prove other terminals and scoped APIs
remain healthy throughout. Complete rollback only after every affected laptop has
its expected original policy and bounds.

A runtime unit under `/run/systemd/system` disappears at host reboot. Restore and
verify it before admitting new pool workers, or retain admission defaults. This
feature does not change the website watchdog, desired-running/vacation intent,
provider runtime selection or operating-system repository configuration.


Employee profiles and session overrides
--------------------------------------

`ProfileStore.stage_config` derives an optional `employeeResources` map from its
locked canonical employee profile, alongside the existing target `sessionResources`
projection. The broker config map is a projection, not another profile store.
Both maps accept only the same six bounded resource fields. An explicit session
entry wins over the employee projection; otherwise the trusted company/storage
binding selects the employee entry, followed by global defaults. Human names,
roles and caller-supplied employee IDs do not select policies. A later approved
session move therefore inherits the employee profile without copying an old SID.
Historical storage edges retain identity but do not grant permission to start.

Both maps are removed before effective-policy hashing, preserving unrelated
laptop labels. Configurations without an employee projection keep the legacy
lookup behavior. A reload still refuses any running laptop whose effective
policy would change: this source support neither resizes existing laptops nor
activates a profile. Profile publication, approved recreation and native owner
acceptance remain separate gates.

## Optional native reservation barrier (source only)

`resourceReservations` is an optional **host-only** broker control binding. It
contains exactly `directory`, canonical `companyId`/`poolId`, `ownerScopeDigest`
and a positive owner-selected `hostReserveMiB`. Its absence retains the legacy
path unless a prior durable control binding or pending installation exists.
This option is omitted from laptop create arguments/hashes; resource reload
still cannot add, remove or change it. It grants no browser or employee rights.

Explicit inactive `worker-service install` can provision a selected empty,
private directory, its canonical ProfileStore and OperationStore directories,
and a single cross-process admission lock. Runtime lookup never initializes a
missing journal. A binding and one-attempt pending file under `stateRoot` fence
incomplete installation, removed options, rebound directories and missing files.
No service starts or employee wakes as a result of provisioning. A failed or
uncertain installation requires inspection; do not delete its fence and retry.
Durable completion and all fallible cleanup precede final pending-file removal.
Power loss may resurrect that conservative fence; automatic reconciliation is
not implemented. This is cooperating owner-controlled storage, not protection
against a malicious host owner deleting or rolling back every custody record.

Control state, including the binding and pending file, must lie outside all
configured and actual engine mount exposures, including read-only, broad,
stopped-container and nested mount aliases. The fixed observer checks complete
engine metadata and kernel mount coordinates. No signing/approval callback is
accepted from route JSON, and this slice implements no approval endpoint.

The native observer binds current employee/session/generation/intent, canonical
profile, actual CID/PID/start tick, finite no-swap RAM/PID limits, host ancestors,
and physical home/Nix/scratch identities through the relevant process root. It
rechecks employee/profile facts after native I/O. A genuine hierarchy root uses
host accounting; missing non-root facts or a mounted/namespaced subroot refuse.
Host headroom comes from explicit policy and current finite facts, not guessed
quota or browser arithmetic. Each metadata scan checks a finite deadline between
bounded engine calls; this is not a kernel hard-timeout guarantee.

An OperationStore claim is itself the durable reserved-SID launch barrier.
Canonical J creation, resource reload and cold recovery share the same admission
lock. New creations account for retained positive deltas; if an old binding or
committed ceiling cannot be proved current, new allocation refuses rather than
crediting its apparent release. All brokers sharing that capacity domain must
use the same protected lock/control root. External owner engine/config changes
are conflicts to observe, not transactions made atomic by this file lock.

No start permit exists in this version. All reserved targets remain fenced and
claims stay charged. Cold views never revive an opaque journal handle, replay an
effect, release capacity or interpret `VERIFY_RECORDED` as verified completion.
An old source legitimately stopped, retired or moved remains recovery-required;
with intact custody/journal this does not strand unrelated existing transports.
Unknown custody or journal state still refuses. Native finalization errors are
unconfirmed; a laptop might already be running, so no blind retry is allowed.

The pure compatibility helper preserves the old SID's exact six fields before a
changed EID projection. It neither publishes config nor rebinds ProfileStore.
The private gate consumes the exact `target_sid` selected in the canonical
profile before approval, requiring the next generation and unchanged profile.
It passes that SID through OperationStore's optional keyword-only `reserved_sid`;
this is not a wire request field or authority. The journal checks distinctness,
retained uniqueness and explicit-target replay agreement under its existing lock.
The fixed observer rechecks the approved profile/generation at commit fences and
the caller rechecks after claim and original store finalization. A fixed terminal
claim context survives to admission exit: the accepted journal reader closes
before terminal native work. Complete engine/custody snapshots bracket the
derived capacity, process and physical-storage facts; a final accepted-journal
file signature then checks for observed replacement or change. Exact profile,
source intent and target namespace facts are checked while the global lock
is still held. No native I/O
follows those terminal metadata checks. External mutations after the final
observations are not made atomic by this cooperating lock. Changed/uncertain
outcomes retain the claim and target barrier. No after-approval profile rewrite or new version is substituted.
Omitted low-level callers retain the original allocation/read-only replay path;
replay never returns a new effect handle. Native prepare/start/verify/settlement,
protected owner approval and HTTP APIs, GUI activation and a selected native
acceptance are **not implemented** by this reservation barrier.
