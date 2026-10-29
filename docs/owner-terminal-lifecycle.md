# Protected owner-terminal website lifecycle

The optional `terminal` and `resource-terminal` website profiles use the same
canonical stopped-container creation and maintenance lock as website updates.
The lifecycle helper coordinates the protected H listener with that creation;
it does not create containers, choose images, restart employees, or grant owner
authority. The optional Nix launcher binds immutable runtime/program/image
manifests. Calling shells cannot supply alternative runtime tools or commands.

At initial installation the owner selects one private `0600` JSON document:

```json
{
  "version": 1,
  "purpose": "reverie-owner-terminal-lifecycle-v1",
  "workerConfig": "/absolute/private/worker.json",
  "engine": {"socket": "/absolute/engine.sock", "identity": [0, 0, 0, 0], "id": "actual-engine-id"},
  "deploymentPath": "/absolute/private/deployment.json",
  "lockPath": "/absolute/private/update-state/update.lock",
  "controlBase": "/absolute/private/h-control",
  "ledgerBase": "/absolute/private/h-ledger",
  "bootstrapRoot": "/absolute/private/h-bootstrap",
  "entitlements": ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
  "externalOrigin": "https://owner.example",
  "ingressPeers": [{"address": "127.0.0.1", "localPort": 3000, "encrypted": false}]
}
```

The example's engine identity and employee IDs are placeholders, not approval.
Roots must already exist, be physically canonical and private, and remain
outside all configured and actual employee mounts. Control and ledger roots
must be durable. The bootstrap directory survives website restarts and is the
single explicit read-only website grant at `/run/reverie-owner-terminal`.
The initial document lives directly in `controlBase`. It names canonical EIDs;
each generation derives only their current SID/generation from company data.
OFF or vacation employees stay unavailable and are never woken.

Standard scripts invoke the fixed launcher with `--installation PATH`:

1. `describe` is read-only and works before lock acquisition. It returns the
   private installation digest, actual lock/parent identity, fixed bootstrap
   mount and immutable profile facts. Scripts open that actual canonical lock
   and hold its exclusive open-file-description lock, inherited as FD 9.
2. `--lock-fd 9 settle` settles the previous H service before website stop or
   removal. It verifies the exact service invocation, program, PID birth,
   cgroup and each recorded shell's fresh native settlement. Unknown outcomes
   refuse. Before any H stop, common admission must be idle: active/uncertain
   host jobs, resource operations and orphan pending fences refuse. The same
   admission lock remains held through H drain, and canonical settled history
   is accepted without resetting journals. An absent legacy domain adds no
   new resource actor; removing an established domain still refuses. Disabling
   the profile still requires this old-generation step.
3. Canonical website tooling creates the exact stopped website from the fixed
   approved profile/spec. Before any H generation or website start, it invokes
   `--lock-fd 9 preflight-created --container-id FULLCID --spec PRIVATE_SPEC
   --spec-sha RAW_SHA256`. This read-only phase verifies the actual stopped
   create/spec/image binding and full declared memory, no-swap and PID ceilings.
   It qualifies the actual host hierarchy, worker commitments and retained
   deltas under canonical admission. Missing facts, removed policy, unknown
   retained sources and insufficient headroom refuse without publishing state.
   An absent reservation domain retains a conservative legacy 90%/8 GiB
   margin including the actual site ceiling; no implicit explicit reserve is
   invented. Standard tooling then invokes `--lock-fd 9 prepare-created
   --container-id FULLCID --spec PRIVATE_SPEC --spec-sha RAW_SHA256`. This
   reuses `WebsiteStage` verification, checks the full image provenance and
   protected mount/runtime policy, then creates fresh control/ledger roots and
   an exact null-init policy. Publication has a durable pending fence.
4. `--lock-fd 9 start-listener` starts only the recognized optional user unit.
   It checks the actual listening Unix socket, owning process and invocation
   without connecting to or consuming the bootstrap accept slot. Only after
   this returns may canonical tooling start that same website CID.
5. `--lock-fd 9 await-ready` qualifies the actual Python-to-Node handoff,
   website incarnation and native service, and the first available protected
   projection. The Node application is released after the host service has
   published that projection. Final metadata checks follow native producers
   and descriptor finalizers. Stopped declared limits are not kernel proof:
   `await-ready` separately qualifies the running site and worker kernel/ancestor
   limits and fresh capacity before returning READY.

The helper does not perform the resource actor's separate explicit facts
refresh. Combined profiles must complete that supported workflow as well.
An ordinary clean website restart creates a fresh H generation, including for
the same CID. Rollback uses a fresh generation with the retained approved
profile; consumed starts, capabilities, PTYs and old handles are never resumed.
The stable recognized unit resolves the current generation and execs the fixed
host program. Changing the compiled program permits only an exact stopped-unit
CAS with the prior unit preserved.

Listener and handoff budgets are each 120 seconds; ready observation is bounded
to 180 seconds. Kernel/engine uncertainty, a live old child, unknown shell
intent, rebound roots, a changed unit or pending publication refuses. A pending
fence may conservatively survive power loss; there is no automatic retry or
receipt-only cleanup. All generations and their one-attempt/history files are
retained. No success is returned after a local finalizer failure.

A legitimate worker policy change invalidates old H contexts. A cleanly
settled policy-invalidated H generation can be followed by a fresh generation
capturing the new policy. If a resource replacement stopped an old employee
while its H shell was still active, its original exact-incarnation settlement
can remain unknown; this helper does not waive that fence. Integrators must
drain H before the conflicting replacement or separately qualify a protected
whole-container settlement contract.

Source fixtures exercise real owned files, inherited flock descriptions,
process births and Unix listeners with controlled service/engine namespace
ports. They are not installed startup, service activation, native PTY, or
employee acceptance. Standard start/update/restart integration and actual
immutable package qualification must be reviewed before activation.
