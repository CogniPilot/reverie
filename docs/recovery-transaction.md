# Fixed recovery outer transaction: source stage

This source increment composes the accepted immutable resume ledger and fixed
message builder on the installed-source receipt 597319e0. It adds executable
transaction, metadata-authority and local ledger transport code with owned
synthetic tests. No route, scheduler, grant, service, configuration, broker or
provider bootstrap registers it. Default construction is unavailable.

## One writer and current binding

`RecoveryTransaction` requires a dedicated trusted authenticated authority, the
real ledger client, a conditional fixed-message provider adapter, a shared
`RecoveryEffectLocks`, and an owned exclusive runtime-writer lease. Initialization
refuses absent/lost runtime lease, reconciles unfinished ledger attempts to
UNCERTAIN, then rechecks that lease. The operator must never initialize against a
ledger with another writer still running. A new configured boolean is not custody
or an exclusive lease.

The closed caller command is only employeeId and operation key. It cannot select
owner, Goal, session, generations, proof, text, urgency, budget or configuration.
`CanonicalRecoveryAuthority` authenticates the dedicated service context before
reading anything. Its selector must use the SAME canonical Goal store, registry
and custody as normal Goal writes. It accepts a closed 17-field metadata record,
not a full Goal/Company snapshot or objective/private content. It refuses extra
fields, accessors, inactive Goal, wrong owner/employee, off/vacation/sleep, pending
input/dialog, active turn/job/tool wait and unsafe/missing fields.

A separate real FROZEN attestor must provide a current positive proof; a busy bit,
health enum, CPU motion, silence or caller assertion cannot substitute. Every
permit re-reads metadata synchronously, compares exact owner/employee/Goal/session,
both generations, transition sequence and canonical revision, checks auth/grant
revocation and genuine proof again. Missing adapters remain unavailable.

`RecoveryEffectLocks.acquire(owner, binding)` serializes the stable employee,
Goal and session keys, bounded to 128 targets. It is a local shared writer seam,
not a claim of cross-process fencing. The runtime lease and conditional provider
must enforce their real single-writer/generation boundary too. The next launch
and compute source must consume THIS seam, not introduce a competing writer.

## Durable order and uncertainty

The transaction obtains current authority, locks the target, calls the accepted
ledger reserve, and only a fresh QUEUED receipt permits proceeding. Replayed
reservations and budget reports never become permits. The unchanged ledger owns
all 3-per-rolling-30-minute accounting at stable employee/Goal/session identities.
There is no second budget, private state copy, generation source or reset path.

Rechecks occur after authentication/FROZEN awaits, after durable reservation,
inside the one-use effect commit immediately before begin, after provider await,
and at all later effect entries. The provider receives a currentness callback to
check after its own preparation awaits and immediately before its actual write.
A valid implementation must use the supported conditional submission operation;
there is no pane input/paste/capture, interruption, wake, arbitrary command or
model adapter. The source cannot certify a not-yet-supplied provider's behavior.

The fixed builder supplies the only message. A pre-effect revocation appends
REFUSED. Confirmed submission appends SUBMITTED; confirmed not-sent appends FAILED.
Thrown/unknown/early success, post-send authority loss and ambiguous acknowledgments
append UNCERTAIN. A failure to persist a terminal transition leaves the original
QUEUED unresolved and disables the instance. Restart reconciliation is the accepted
ledger operation, never resend or delete/reset. No completion/progress is invented;
future authenticated observation must append the supported existing stages.

Commit can run only once and is closed before target release. Late prepare/commit
callbacks cannot create new effects. Requests have a fixed five-second authority
window; each owned local ledger child has a four-second bound, isolated Python
flags, sanitized environment, fixed trusted paths, bounded input/output and fixed
error strings. Separate uncertainty-recording cleanup is bounded to five seconds.
Expired authority is not extended. A timeout cannot prove remote effect cleanup;
provider cancellation/conditional-write evidence remains a required adapter gate.

## Actual source availability and next integration gates

The current 597 source does NOT contain the accepted Goal server/bootstrap or a
positive FROZEN observer. The smallest required production input is the exact
same-store 17-field selector plus dedicated authenticated scoped grant lease,
current real FROZEN lease, owned exclusive service lease and conditional provider
submission adapter implementing the callback protocol. None is guessed from
current live metadata or replaced with a synthetic positive outside tests.
Existing owner-only Goal and original-program observer holds remain unchanged.

The local ledger client DOES invoke the unchanged accepted Python SQLite ledger;
owned tests prove append-before-effect, limits and restart fencing across actual
separate child processes. This is not installed custody, capacity/latency,
provider/auth, image or full-day report-only acceptance. Maximum ledger cost,
private directory and packaged interpreter/helper custody, same-store wiring,
report-only/dry/canary stages and explicit operator activation remain open.

No host, model, real resume, grant, configuration or image action is authorized
by this source. New files are not imported by any production entrypoint. Broad
repository/native/image checks are not replaced by the focused tests.

## Focused qualification layout

The Nix console source is flattened to apps/web. Its postPatch copies exactly the
accepted ledger, new RPC transport and inert package initializer into an owned
test fixture; four named suites are added to the existing gate without removing
any. Repository tests use their sibling Python source; flattened tests must use
that explicit packaged fixture. No third source/search fallback is used. Tests
resolve the build-tool Python executable rather than assume a host /bin path.
Both layouts are exercised locally; this is not Nix evaluation/build acceptance.

The new outer algorithm, metadata policy and RPC client are source ready for
review. The actual same-store selector, authenticated resume principal/grant,
positive FROZEN observer, exclusive installed writer lease and conditional
provider adapter remain concrete missing implementations/wiring, not an operator
boolean or permission to activate a synthetic fixture.

## OR01 clock/expiry successor

Observed wall-clock regression is permanently latched unavailable in the current
service instance. Ledger timestamps retain their existing clock floor unchanged.
The operation also has an independent monotonic elapsed start/floor and exactly
one five-second expiry timer. Remaining waits use the smaller wall/monotonic
budget and never renew or exceed that original ceiling. A stalled wall clock,
regressed clock, delayed provider preparation, synchronous authority check or
provider-after-await callback cannot extend authority. The final currentness
check samples the operation window again after synchronous permit validation.

A regressed/unusable clock may make even the refusal/uncertainty append unsafe.
Then the durable QUEUED record remains unresolved, the instance becomes
unavailable, and accepted restart reconciliation later appends UNCERTAIN under a
valid trusted time. There is no blind resend, clock-floor reset, budget reset or
uncertainty clearance. Local lock release does not settle an uncertain provider
effect; later launch/compute must respect the durable uncertainty boundary too.
The same cleanup five-second cap remains distinct from effect authority and
never permits another effect. No new deadline duration or policy is introduced.


## Confirmed dead panes

The verified owner's expert Restart action uses a fresh mux observation before
recovering a dead pane. It preserves the saved account, model and native
conversation. Stale work-detector flags do not block this recovery; actual
running tasks, owner stop/vacation, changed EID/SID/generation, an overlapping
restart and an unconfirmed pane observation still do. The final tmux operation
omits `-k`, so a pane that became live is refused. Failures do not automatically
send a second launch or break another process's storage lease.

For an isolated laptop, the outside pane observes its terminal transport.
Normal J reattaches a live inner provider; a confirmed dead inner pane is
rechecked and passed to the existing exact-CID/PID stop and canonical recreation
path. A read-only reconnect never creates a replacement. Runtime/account changes
in place remain unavailable for an attached isolated laptop. An HTTP recovery
response means the normal launch was requested, not proof of native provider
readiness. Package and installed acceptance remain separate.

Session and company projections include `runtimeHealth` and
`runtimeHealthScope`. A confirmed local exit is `dead`/`provider`; an isolated
worker's outside exit is `disconnected`/`terminal`. Missing evidence is `unknown`,
never proof of healthy work. Transport-only exits do not automatically mark an
employee OFF through the clean provider-exit sweep. These fields are observations,
not owner intent or a permission to restart.
