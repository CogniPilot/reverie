# Host cutover handoff

Status: review procedure, not an instruction to restart now. The container runtime
engineer prepares the complete candidate and acceptance package; the CTO schedules
and approves it. The external host operator performs only the approved engine and
user-service cutover. An engine socket is not mounted into agent containers.

## Before stopping anything

1. Complete [image-rebuild-handoff.md](image-rebuild-handoff.md). Re-read the latest
   originating channel, verify the active CTO binding and approval, and confirm no
   crossed hold. Obtain the instance's current protected research/sleep/deploy
   windows from its private handoff and agree a quiet window; do not assume an
   old schedule still applies.
2. Save the current image digest, container inspect/create settings, launcher/unit
   versions, service status and rollback identifiers to a private durable handoff.
   Inspect output can contain secrets: restrict permissions and post only summaries.
   Record employee/session/native-thread mappings, room membership and REAL provider
   CLI PIDs. API attach PIDs change at a console restart and are not sufficient.
3. Verify the required durable binds against live inspect and the owner plan.
   These are placeholders, not literal paths or a request to add mounts. Actual
   host paths, instance names and access routes belong in the private handoff:

   | Host location | Container target | Mode |
   |---|---|---|
   | `<host-source-root>` | `<container-source-root>` | read/write source |
   | `<host-scratch-root>` | `<container-scratch-root>` | read/write disposable work |
   | `<host-instance-root>` | `<container-instance-root>` | read/write instance |
   | `<host-agent-home>` | `<container-agent-home>` | read/write native history/config |
   | `<host-published-root>` | `<container-published-root>` | read-only, if already configured |

   Resolve symlinks before comparison. Engine storage remains in its configured
   durable data directory, never disposable scratch. Preserve existing network,
   capabilities, user mapping and resource settings except the explicitly reviewed
   diff. Verify the configured private access route against the instance handoff;
   add no public listener or router forward.
4. Obtain fresh agent handoffs. Arrange application-consistent backups/checkpoints
   of durable data, using the owning application's method or quiescing writers;
   do not treat copying a live database file alone as a valid backup. Never restore
   older rescue data over the recovered home or current instance.
5. Review a concrete dry-run and rollback plan. **Do not blindly run
   `scripts/reverie-recreate --replace`: its current implementation stops/removes
   the existing container before building.** A reviewed cutover must build first
   and retain the old container/image rather than remove them. The helper's dry-run
   is reference material, not proof that its mutation path meets this requirement.
   Tracked blocker **RECREATE-001** below must be closed before the next recreate.

## Tracked prerequisite: RECREATE-001

**Status: OPEN. Owner: runtime engineer. Blocks the next recreate.**

Fix `scripts/reverie-recreate --replace` to build and verify the candidate before
stopping production, and retain the old container and immutable image for rollback.
Do not merely move the current removal command later. Private assignment and
deployment-specific evidence belong in the instance handoff.

Acceptance requires independent review and isolated fake-engine tests proving:

- A failed candidate build does not stop, rename or remove the running container.
- A successful cutover retains the old container/image with recorded identifiers.
- Replacement create/start failures leave a usable retained rollback and report
  recovery instructions; neither production nor rollback data is deleted.
- The replacement uses the accepted image digest and reviewed create settings.

The CTO records closure with those receipts before authorizing the next recreate.
This tracked item does not authorize running a cutover or deleting rollback data.

## Cut over once

Stop the host watcher and verify its in-container processes are gone before
stopping the console/container. Quiesce the old writers; retain the stopped old
container under its rollback identity. Create the replacement from the accepted
digest with the reviewed settings. Verify any required live-layer carry before
starting it. Never run two consoles against the same writable instance/home.

Let the existing host user service own startup. The runtime engineer restores or
resumes agents through the supported console flow, checking persistent identities,
native threads, room bindings and profiles before declaring success. Do not spawn
new agents just to make an empty dashboard look active. The configured local agent
must exist exactly once before re-enabling its watcher; verify one active watcher.
Update the host bridge binding through its supported identity flow if needed.

Acceptance: API healthy on the configured private access route; supervisor
loads `FLEET_RUNTIME_POLICY` from the external env file; chat send/receive, unread,
poll and delivery receipts work; histories remain accessible; provider CLIs resume
the recorded native threads with no duplicate identity. Confirm model responses,
admission/resource limits, timers and watcher health. Apply the separately reviewed
GPU acceptance only if that device change is part of this cutover.

## Rollback and takeover

On failure, stop replacement writers and retain their logs/data. Use the reviewed
retained container/image after checking whether newer persistent schemas are
compatible; restoring an older binary is not automatically a safe data rollback.
Keep watcher supervision stopped until exactly one intended local agent is healthy.
Do not delete containers, images, histories or stopgap tool paths as cleanup.

Record image/container IDs, timestamps, manifest checks, unchanged/rebound identities,
smoke results, remaining issues and rollback location in the durable handoff.
Post the result to the originating channel, without private inspect data.

The runtime engineer's next takeover task is a reviewed deployment package/tool
that produces this manifest, preflight, candidate tests and cutover/rollback plan.
The host operator then consumes that bounded package rather than reconstructing
agent state or patching live source by hand. Host engine control stays external;
further automation requires its own owner-approved boundary.
