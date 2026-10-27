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
