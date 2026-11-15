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

## Reserved settlement space

The whole journal, not each operation, is bounded to 8 MiB and 100 records.
Before a native seed is admitted, the same locked writer reserves the remaining
maximum encoded record growth. The constructive witness is decoded by the actual
Zod schemas. It includes the retained source row, both source/destination HOME
copies, all five task roles, 32 ephemeral attempts with 4096 UTF16-unit paths
encoded at six bytes per unit, duplicated request/ACK identities, the optional
source-reader closure, safe-integer extrema and every coarse failure/recovery field.
No credential or context bytes are stored in the journal.

The private versioned dockerSettlementBudget field is written before dispatch.
Previous strict readers refuse that field; exclude old runtimes before activation.
Private records without a published reserve cannot dispatch. Immutable completed
or failed histories release future growth reserve but remain present for account
lineage; they cannot be resumed, rewritten or silently evicted. Full retained
history can refuse a new request rather than delete evidence.

A genuine capacity refusal is correlated only to the new, absent original ID
under the canonical lock and only after its checked consuming close. The force
API may return the exact origin-marked notIssued DATA; cooperative failed-request
status retains startRefusal. Message/status/cause lookalikes, mismatched originals,
post-write failures and uncertain closes never receive that marker. It confers
no permission and never authorizes automatic retry.

The optional sourceReader cursor belongs to this same journal outside the five
target work tasks. Source CID closure precedes its creation; CREATE/START/close
intent precedes each corresponding effect, exact scope stays immutable, and a
known reader must close before provider-issued. Its raw source bytes remain
private in the native actor, not in this DATA. Normal close follows durable
target material installation; uncertain helper effects remain held and are never
restarted from metadata.

Resolved `material` metadata is committed atomically with the first target work
record, before its native tasks. It contains only the selected context descriptor
and credential digest; credential bytes and context file contents stay out of the
journal and public move DTO. The shared material encoder binds both hashes to the
exact target operation, session, provider and account. Once present, this metadata
cannot change or disappear. Historical work without it remains readable, but
cannot acquire it retrospectively as a recovery shortcut.

This retained descriptor lets the owning native actor re-earn an already installed
generation after the source reader has closed. It supplies no installation or
provider credit: recovery still needs the original helper acknowledgement and
fresh actual target observations. Capacity reservations include the maximum
escaped context paths accepted by the same codec.

## Network membership

New plan replacements persist a sorted set of 1–16 actual Docker NetworkIDs in
`planReplacement.source.networkIds`. The native actor earns this DATA through
`Engine.planReplacementNetworkIds(sourcePublishedRow, current)`, which brackets
the exact stopped current source placement twice. The array does not grant an
effect. CREATE independently rechecks the stopped source after pool/ephemeral
awaits and requires that exact set.

The new destination requests only `NetworkingConfig.EndpointsConfig` entries
whose keys are those immutable IDs and whose values are empty objects. Source
IP addresses and endpoint aliases are not copied; the control and network objects
are not changed. The original primary HostConfig network mode is preserved.

Docker reports empty NetworkID values for some Created/PID0 endpoints. At those
pre-start phases only, the adapter resolves the exact reflected selectors through
bounded read-only network inspection and checks each returned actual ID against
the persisted set, while bracketing target config/state. Empty IDs themselves
never prove identity. After START, target observations require the exact actual
NetworkID set and never use selector fallback.

Legacy v1/v2 behavior remains unchanged. A previously published v3 record without
the new field can still be inspected, but cannot create another destination.
New-field publication remains subject to the documented exclusive control
activation boundary; this does not claim a fence against an already-running old
writer.
