# Docker plan replacement journal

This source packet adds private DATA and store CAS. It does not install a native
replacement actor or enable Docker plan effects. The generic Docker launch guard
remains in place until the independently qualified native actor is integrated.

## Activation and rollback boundary

Before the first native journal publication, replace the old control process
through the supported single-writer Docker update. An already-running predecessor
can save cached legacy records without reloading or taking the new lock. It can
therefore overwrite new journal DATA. The literal predecessor regression reproduces
this; the new lock is not an old-binary writer fence.

A cold predecessor's strict record decoder rejects the new private field. Rolling
back to that binary requires the owning reviewed migration/recovery workflow;
never remove new fields, cursors or uncertain intents to make it read.

## Same-journal ownership

The private Docker stanza binds the actual old employee/SID/generation/CID and the
fresh target identity. Its handoff and retained source descriptor are private.
Public plan views omit the stanza. No credential bytes or raw runtime Env belong
in it. Account source is either canonical or an exact retained generation; that
selector is DATA, and actual closed lineage/account custody must be earned by
the native actor.

Every native effect and publication must check the actual persisted actor epoch.
A publication compares the exact original stanza under the same canonical flock,
writes atomically and confirms the exact new bytes. Authority checks after that
publication must not require the old cursor digest.

An explicit pre-paid takeover requires genuine fresh native settlement proof
inside the writer lock. It changes only the actor epoch. All existing task and
source-stop identities remain immutable. Once provider-issued is present, takeover
and provider replay refuse. A lost publication/finalizer reply remains uncertain;
an exact original read can inspect what was actually committed.

The opaque native actor and server requester grant remain required separately.
These store tests use injected native checker ports to test CAS; they do not claim
physical source closure, account projection, kernel proof or paid dispatch.

## Requester and recipe currency

A new choice requires the actual signed-in owner or a genuinely registered boxed
HMAC request with the appropriate live self/team plan permission. The private
requester proof binds its move ID, target account, source generation and force
choice. Preview/source inspection does not grant reservation. Original-operation
recovery reads the retained private PlanMoveStore itself and may use an explicit
recoverEmployees grant; it cannot select a new account.

The verifier issues a narrow plan-request continuation while the worker identity
is current. It retains original issuer lifetime/key custody and immutable,
unmixed request credentials even when this journal legitimately stops its own
source binding. Every requester check still invokes this issuer continuation.
It does not authenticate a new API request or grant a new worker binding.

A planned target must match this journal's issued/published handoff and complete
binding tuple. Its current canonical RuntimeRecipe must match seed.target.templateDigest.
That digest uses the same locked stock native-thread observation projection as
existing-provider source correlation. Only native observation fields are omitted;
account, provider, model, workspace and configuration remain exact, and unknown
protocols remain strict. Actual saved-state/native recipe and physical proofs
remain the actor's separate responsibility.

These grants authorize admission through final publication. They must not become
enduring viewer/health currency after the operation finishes. A published native
view retains its independent canonical/runtime/native checks.
