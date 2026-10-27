# Private resource replacement preparation

This is an unregistered host integration primitive, not a ready resource actor or
owner API. No current Broker, HTTP/UDS route or `PlanMoveResourceRuntime`
dependency exposes it. Do not wire its internal configuration transaction until
current owner authentication and native server/service custody are qualified.
Source fixture success is not native installation, owner approval or a seat resize.

## Implemented preparation slice

`worker_resource_preparation.ResourcePreparationOwner` retains the **same**
`OperationStore` and opaque in-process handle that created a protected claim.
The public metadata-only `ReservationGate.reserve` still closes/discards its
handle. Replayed/cold lookups cannot recreate ownership. Closing an owner keeps
the durable claim, positive hold and reserved-target refusal fence.

The private sequence is:

0. A protected private draft preselects operation ID, reservation ID and the
   profile target SID before approval, binding exact profile N and the native
   snapshot. Preview writes only bounded private metadata: no journal claim,
   positive hold or process-local effect handle. Closing preview cannot leak a
   positive reservation. IDs are not approval or a capacity promise.
1. On actual executing Apply, claim those exact preapproved IDs with the canonical profile's exact preapproved target SID/version while the
   old source binding and actual native snapshot are current. Capture source
   paths and old policy under the admission lock, before terminal observation.
2. Commit journal `PREPARING` before intended metadata/config effects. An
   exclusive, durable publication-intent record fixes the original employee and
   the intended target SID/next generation. It is not a native preparation ACK.
3. A future fixed server publisher must create only owned non-running Session
   metadata and use normal `CompanyService.rebind`; this Python slice does not
   write company/session JSON. `confirm_publication` observes exactly the intended
   transition and unchanged profile N. It compares the still-running old native
   CID/process/storage to its original snapshot instead of requiring the old SID
   to remain the company's current transport. Other employee/intent changes refuse.
4. Real `ProfileStore.stage_config` plus the OLD six-field compatibility helper
   produces the target/EID projection and exact old-SID compatibility override.
   The approved profile is never rewritten or assigned a new version.
5. The unregistered `_commit_configuration` transaction checks complete native
   custody for the host policy, writes an exclusive attempt and raw before backup,
   fsyncs a same-directory temporary, rechecks exact source/native/profile/config
   custody and file CAS, then atomically replaces the policy. It invokes the normal
   `Broker._reload_resources`, with one fixed PREPARING-only exception for exactly
   that candidate. Ordinary reloads and all ordinary reserved-target J requests
   remain refused. No generic callback supplies native/approval authority.
6. A fixed producer verifies policy file, actual broker selection, unchanged old
   native limits/process/EID roots and profile N before issuing its closed native
   preparation receipt. Only its digest is recorded as journal `PREPARED`. This
   is configuration preparation, not proof of stopping, starting, readiness,
   verified completion, free capacity or permission to release a claim.

Every blocking native producer precedes a final complete native/custody equality
bracket. Journal, phase and actual policy file signatures, exact profile, employee transition and
storage namespace are checked afterward under the global admission flock. No
further native work follows those terminal metadata reads. Once configuration
preparation begins, the actual anchored policy file and parent must still match
the exact before/candidate phase after native producer work. A fixed policy-only
fence also runs after the journal ACK scope guard, while its existing flock is
held, so that guard cannot admit a PREPARED ACK from stale in-memory selection. External mutations
after their final observations are not made atomic by a cooperating file lock.

Any uncertain rename, reload, ACK, finalizer or postcommit observation retains
claim/attempt/backup/temporary evidence. The transaction does not restore policy,
delete evidence, replay work or credit capacity. A cold owner has no effect handle.

## Required next implementation seams

The fixed TS adapter must compound executing reserve as host claim/PREPARING, normal server
metadata/CAS publication, then host confirmation before returning `{sessionId,
launchKey}`. TS requires the target company binding before its later `prepare`.
Its resource intent IDs and runtime digest are references, not owner authority.
Those operation/reservation IDs are already present in the approved TS input.
The fixed adapter consumes the protected preselection draft only on executing
Apply, then retains the newly created real claim/handle for that execution. It
must not rewrite approved IDs, reopen a cold claimed operation or hold capacity
while the owner merely considers a preview. Optional low-level operation and
reservation preselection is canonical/distinct/retained-unique and explicit replay
must match under the existing journal flock; omission preserves legacy allocation.
The internal primitive here precedes the TS adapter, rather than implementing its
four-method interface. Known-no-effect cancellation and terminal claim accounting
still require explicit reviewed semantics; no fake VERIFIED receipt resolves them.
The current strict phase accepts only SID/generation changes; a normal rebind's
recipe/thread changes must be tied to the exact approved launch/runtime recipe,
not allowed through an arbitrary field whitelist or caller-supplied employee row.

An explicit optional installer-owned bootstrap must bind the current website
native CID/epoch, service purpose, protected key/nonce roots and server owner
session. Reuse the audited private-file/custody/nonce machinery in `goal_private`,
`goal_bootstrap` and the server's `ownerGoalAuthentication` pattern where suitable.
A distinct resource purpose is required; an employee OPS decision must not
impersonate a human owner. Normal `OwnerAuthService` session, same-origin and
no-parent-header checks must precede signing. UID, title, a UUID or JSON saying
owner must never mint approval. No runtime auto-create-if-missing trust is allowed. Current owner/session, purpose,
expiry and nonce checks must also fence every subsequent effect boundary; a
single entry check cannot authorize a long transaction after logout or expiry.

Actual start must consume this same retained operation once, record `STARTING`
before its effects, verify the old native CID/processes and writer leases are
released, then use shared canonical broker creation helpers with a one-operation
protected permit. No generic J/interactive fallback may bypass the durable fence.
The new CID, effective cgroup limits, current EID binding, unchanged account/grants
and same physical home/Nix/scratch roots require native verification.

Actual verify/finalization must cover `VERIFYING`, real native/CLI readiness and
the TS synchronous final-fence contract. A host ACK or receipt hash alone cannot
release the durable hold. The server completion and final native reobservation
need a protected commit protocol; restart, lost ACK and stale handles cannot
silently replay or manufacture credit. None of start, verify, credit, an owner API,
GUI activation or selected native acceptance is implemented by this slice.
