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

A guarded initial-activation continuation is available as
`reverie-owner-terminal-website ... resume-created --operation UUID --plan-sha256 sha256:...`.
It accepts only the exact retained, never-started candidate after a pre-stop
validation refusal, while the original website still matches its live CAS.
The original plan, receipt and candidate must match; any H phase evidence,
stop/start attempt, partial history or previous continuation refuses. The
initial failure is preserved and a durable exclusive continuation attempt
precedes effects. All ordinary admission, checkpoint, settlement and ready
checks still run. It does not recover a started candidate or unknown native
phase, and a failed continuation cannot be replayed.

Docker may omit `--tmpfs` grants from `Mounts` even for a running container.
The generated declaration is checked in full through `HostConfig.Tmpfs`; any
reported mount entries must agree. Initial activation separately qualifies
the live PID's `/tmp` and `/run` from kernel mountinfo and anchored directory
metadata, including tmpfs type, flags, size, ownership and mode.

If that first continuation itself refused only in the local, file-only create
qualifier, a separate owner-reviewed `continue-created` action accepts a fresh
`--continuation UUID` and `--receipt-sha256 sha256:...` CAS of the current raw
failure receipt. It requires the exact closed initial/resume histories and
three unchanged qualifier input files, the same never-started candidate and
unchanged live original website. Any native phase marker, accepted qualifier
result, extra file or changed fact refuses. This additional cold-validation
attempt preserves both prior latches/failures and creates its own exclusive
attempt; there is no further continuation, automatic retry or fresh-UUID loop.
Prequalify the sealed actual inputs against the exact new immutable qualifier
before invoking it. Empty/null Docker `UsernsMode` is a recognized default;
nonempty namespace selections remain refused.

If the observation window expires or its aggregate native fingerprint drifts
before any new continuation is consumed, `prepare-continue` creates a separate
private renewal for explicit owner review. It takes the original prepared UUID
and plan SHA, a fresh continuation UUID, exact raw failed-receipt SHA and an
explicit private prior provider-baseline input. It preserves the old selection,
plan and baseline bytes and records a complete fresh native snapshot. The new
plan may differ only in its native observation fingerprint; every old authority,
command, image, mount, resource, owner-input, control, grant and old-container
pin must match. The same provider PID births, executable paths, laptop IDs and
init PIDs are independently requalified.

The original full native witness was not available in older prepares; renewal
honestly records that fact and makes no claim to identify or ignore the old
fingerprint's drift. The owner reviews the complete new witness and exact new
plan SHA before invoking `continue-created` with that renewal's UUID. Apply
rechecks those private inputs and live facts, consumes the new exclusive latch,
preserves the original canonical plan byte-for-byte, and CAS-publishes the
reviewed new plan under the existing maintenance lock. Any partial publication
remains held. The old failure and consumed attempts are never cleared, and the
additional continuation remains bounded to one attempt. All future ordinary
prepares also retain their full native snapshot.

After an explicitly reviewed owner restoration of the original website, a
never-started candidate can be closed as separate historical metadata with
`prepare-abort-ack` and `ack-abort`. This does not perform the restoration or
claim that the failed H preparation completed. Both commands are host-owner
operations; neither changes containers, services, company data or permissions.

The prepare command requires the original prepared UUID, exact current parent
plan and raw failed-receipt SHA, a fresh acknowledgment UUID, private operator
restoration evidence and the prior provider-baseline file:

```bash
reverie-owner-terminal-website --installation /private/control/installation.json \
  prepare-abort-ack --operation PARENT_PREPARE_UUID \
  --plan-sha256 sha256:PARENT_PLAN_HASH --receipt-sha256 sha256:RAW_RECEIPT_HASH \
  --continuation FRESH_ACK_UUID --provider-baseline /private/provider-baseline.json \
  --operator-abort-evidence /private/owner-cold-abort-evidence
```

Preparation preserves the expired original selector and creates a separately
selected finite observation window. Its review plan includes the complete fresh
native witness, current restored website incarnation, unchanged grants and
configuration, provider PID births, sealed checkpoint, original histories and
operator evidence. A restored original restart policy may be `no` or
`unless-stopped`; all other captured host configuration must match. The retained
candidate must still be exactly identified, never started and unchanged. No H
unit, current/pending generation, bootstrap channel or issued ledger may exist;
only the exact recorded unpublished policy namespace is eligible.

After reviewing the returned exact acknowledgment-plan SHA, invoke `ack-abort`
with the same installation, original prepared UUID, acknowledgment UUID and raw
parent-receipt SHA. Pass the **new acknowledgment-plan SHA** as
`--plan-sha256`; omit the two prepare-only evidence arguments. It requalifies the
native facts under the maintenance lock, consumes exclusive owner-acknowledgment
latches, and publishes a distinct `OWNER_ABORTED_NEVER_STARTED` receipt. Every
parent failure, H phase attempt, unpublished policy and held candidate remains
retained. Partial publication refuses further replay.

Future ordinary preparation recognizes only that qualified historical closure.
It still requires a fresh owner selection/window and a new schema review ID and
operation with exact final-spec approval. The acknowledgment never resumes an
old attempt, revives a consumed bootstrap or converts an unknown H phase into a
successful phase result. Changing or losing any retained parent evidence,
starting the held candidate, or finding a published/issued H context refuses.

Raw `docker restart`, Docker's `unless-stopped` restart after daemon/host boot,
and restarting only the H unit do not run this generation workflow. The only
bootstrap listener is retired after handoff; website death ends that protected
channel, and a consumed `START-ATTEMPT` prevents reuse. An exceptional website
death may also leave no canonical drain receipt. These cases remain held, not
automatically recovered. Production activation must therefore remain disabled
for deployments relying on those restart paths.

The next bounded acceptance must use a disposable instance with no personal
mounts: qualify canonical stop/drain/new-generation ordering, an ordinary
website restart, daemon restart and simulated host boot, and recovery readiness
with the broker's startup requirements. Verify normal owner authentication and
a real browser terminal, unchanged providers during website-only maintenance,
retained employee/conversation bindings after cold boot, and preserved unknown
fences. The existing synthetic PTY acceptance does not claim those results.
