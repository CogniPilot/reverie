# Docker live soft-memory revisions

The verified owner may approve a soft-memory default for all current and future employees. This is desired policy, not a claim that a kernel write ran. The fallback unapproved proposal is 48 GiB. An existing operation retains its exact original request, policy, helper tasks, credential, destination and binding. New operations project the approved default and snapshot it through the canonical Company writer when staging that new operation, before its original policy is used. A soft limit above the original hard ceiling is refused; no hard/pool/swap/CPU/PID limit changes implicitly.

The separate private docker-resource-revisions journal sits beside the canonical company file, outside runtime-key custody. Cross-process flock and complete-file fsync/rename/fsync publication precede helper effects. Defaults and operation-scoped histories remain retained; no malformed-file repair, rekey, automatic deletion or private-row rewrite exists. A lost publication finalizer holds that writer. A fresh process can read the complete durable cursor, but cannot repeat an issued effect.

## API

All endpoints require the actual human owner. Worker identity/recovery/office permissions do not authorize policy edits.

- GET /api/company/docker-resources: desired default and employee history, explicitly enforcement not-observed.
- PUT /api/company/docker-resources/default: body {revision, expectedRevision, scope: "all-current-and-future", memoryHighBytes}. The expected revision is the prior owner UUID or null. Desired-only publication performs no Engine effect.
- GET /api/company/employees/:id/docker-resources: fresh fixed kernel observation; no journal write, CREATE or START. Reports actual/desired high and whether the actual original/revision policy is approved. Unadopted matching kernel values remain visible without manufacturing an ACK.
- POST /api/company/employees/:id/docker-resources/reconcile: body {revision}. Read-only Engine operations qualify the retained issued writer and publish separate NoFutureWriter metadata. This never CREATEs, STARTs, writes a kernel setting or invents the missing old ACK.
- POST /api/company/employees/:id/docker-resources/apply: body {revision}. Under exact current owner/employee/SID/generation/binding/recipe/row and original Docker configuration, adopt matching facts without helper writes, or issue one separately journaled fixed Rust configure-memory-high helper. Only that leaf is writable.

Success distinguishes observed adoption from applied helper ACK and reports actual effective policy. It never asserts that a historical original helper enforced a later limit. Reads use original ACK as historical binding evidence and current kernel facts as actual enforcement. A private branded proof permits approved high-only changes in existing-provider/view reads, never in begin, provider creation or original resource configuration. Desired-only changes retain the last approved actual policy until a later real attempt changes it.

Any unknown helper for the same physical CID prevents another revision/scope writer. Retained CREATE can be located and fully qualified; START-issued can only be waited/observed, never started again. Actual qualified Exit0/log ACK and same kernel identities must finish it. Matching current values cannot settle an unknown cursor. A separate reconcile action may prove the exact issued high-only helper terminal: full protected configuration and originally selected immutable image are revalidated, two exited/PID0/NoRestart observations bracket a fresh same-leaf kernel observation. Running, created, restarting, changed or unknown helpers cannot close. The original cursor and unknown outcome remain unchanged in retained history; it is never STARTed again. Once no future writer is proved, a separate fresh matching policy may be adopted without claiming the earlier effect succeeded. If the current limit differs, an explicit new owner revision permits a new helper only after all prior writer identities are freshly proved closed. No blind retry, global prune or host resource socket exists.

## Automatic convergence and view lifecycle

A separate resource phase runs after API-origin setup and before existing-view restoration. It also runs when returning a seat to office and through a coalesced 10-second controller, at most two visits and 64 eligible active bindings. Settled history skips full resource scans. Future operations snapshot the owner-approved default in their new canonical original policy; an already-original48 operation needs no extra resource writer. Older16/8 operations retain their exact row and converge through separately journaled high-only work or read-only actual48 adoption.

Automatic convergence first requires genuine double protected native LIVE provider proof. A provider-issued row whose launch is pending/absent cannot cause a writer or adoption. Owner approval after server startup triggers convergence and existing-view restoration without another Apply or BEGIN. Offline seats retain desired policy; normal authorized office return performs convergence. Unsupported writer capability remains a visible resource refusal and cannot disconnect a genuinely valid original16 view.

Existing provider/view publication has a private preparing/published/failed phase. The real request actor/wake lease remains required through final attachment publication. Finishing that one-shot lease afterward does not disconnect a valid canonical view. Any publication failure permanently poisons the minted view, even while canonical attendance remains active. Paid launch denial, intrinsic unknown input and every original journal stay intact.

The profile GUI is separately composed using these permissionchecked APIs. The company status projects closed-writer with writerClosed and originalOutcome unknown; a subsequently adopted closure projects observed history. Summary enforcement always remains not-observed. Advisory allowedActions are apply, reconcile or new-revision; the backend repeats every authority and native check. The original qualified image in retained task history grants read-only closure verification, never selection of a new writer under an obsolete pin. No image or production effects are performed by these source changes.

## Independent writer capability

The existing helperImageId remains the original box/anchor/pool/probe/baseline-ACK image. An optional, independently qualified memoryHighHelperImageId selects the new high-only writer. It never participates in the box ID (which remains runtime instance ID plus deployment), never changes the runtime key, and cannot replace an old anchor or ACK image. The write image must support the fixed configure-memory-high program and advertise the deny-only v1 capability; labels are not a substitute for the operator-qualified immutable image pin.

Absent/unsupported writer capability refuses a high WRITE before a writer cursor/CREATE. Existing qualified helper908 still supports read-only actual48 observation/adoption. New writer selection or revision scope changes during an awaited effect revoke that attempt; no fallback reuses old configure-high, which also writes CPU weight. The new mode must write only memory.high, assert all other original limits, and earn fresh readback. Image/native qualification remains a separate deployment admission; source tests do not claim a new image was built.

## Original preSTART recovery

The same canonical predicate controls default-approval advisory and publication: a pending helper or full retained history does not offer a fresh default approval. Action lists are nonauthorizing DATA; every endpoint repeats current owner, revision, binding and physical checks.

| Retained state                                                         | Explicit actions                    |
| ---------------------------------------------------------------------- | ----------------------------------- |
| No desired policy                                                      | None                                |
| Desired, no attempt                                                    | apply                               |
| helper create-issued or created                                        | continue-original, abandon-original |
| helper start-issued, running or completed                              | reconcile                           |
| closed-writer or unstarted-retired                                     | reconcile, new-revision             |
| observed, applied, observed-after-closure or observed-after-retirement | Read-only refresh                   |

POST .../docker-resources/continue and POST .../docker-resources/abandon take {revision}. Continuation qualifies the original task and uses its canonical CAS before a first START. It never repeats CREATE or an issued START. A missing original CREATE remains unconfirmed.

Abandonment is available only before any START intent. An atomic transition retains the exact original task under purpose reverie-memory-unstarted-intent-retired-v1. This canonical fence prevents a late CREATE callback from publishing created/START state. It is not proof of Docker absence or a terminal native writer: intentRetired is distinct from writerClosed. Any observed named orphan must have exact fixed configuration and created/PID0 state before retirement and before a later writer; a running or unknown orphan refuses. Late CREATE may leave an inert retained orphan; the application never starts or deletes it.

Retirement preserves the original unknown CREATE outcome. Read-only reconcile can subsequently adopt fresh matching approved facts; otherwise a new explicit owner revision may issue a new helper after all prior writer/intent fences are freshly checked. No old task or historical ACK is rewritten.

Default publication has a narrow not-issued error DATA response: {code, action: "approve-default", revision, publication: "not-issued"}. A private typed outcome is minted only by that request's locked prewrite validation and escapes only after checked lock close. A retained error, aggregate close failure, transport loss, auth failure after publication or publication finalizer never carries this marker. A client may release only the matching pending nonce after a fresh authenticated GET; the marker never authorizes a PUT retry or any helper START.

## Settlement capacity and journal version 2

A helper intent reserves its entire largest schema-valid settlement before any cursor publication or helper CREATE. The bound is computed from exhaustive valid witnesses for every task phase and attempt variant: 150,170 UTF-8 JSON bytes, including both identity copies in observed-after-closure. Each of three 4096-code-unit paths may require six JSON bytes per unit; safe integers, ASCII regex strings, names and decimal fields use their actual schema maxima. Mandatory tests cover the union variants and accepting/rejecting field boundaries. This is a byte bound, not an estimated row count.

The 2 MiB journal budget includes unused reserved bytes for every helper and every still-mutable latest-revision closed/retired record. Concurrent admissions account for existing reservations under the same canonical flock. Final adoptions are immutable. A new owner revision makes old terminal/retired history immutable and releases only its unused reservation; all original metadata remains retained. Finite byte/record/revision capacity still requires future supported history maintenance; this change does not delete history or invent cleanup authority.

Readers accept versions 1 and 2. Reading accepted version 1 does not rewrite it; every actual new publication atomically writes version 2, and an instance which observed 2 refuses a later 1. Frozen version-1 readers refuse the new envelope, so rollback cannot ignore the reserved-capacity invariant. Existing version-1 data is preserved, but an already-overcommitted old journal cannot retroactively gain file space; no silent history deletion or limit widening is performed. Newly admitted intents carry the prospective settlement guarantee.

An actual initial apply/adoption capacity rejection can return HTTP 409 with {code: "DOCKER_RESOURCE_REVISION_CAPACITY", action: "apply", publication: "not-issued", employeeId, sessionId, sessionGeneration, operationId, containerId, revision}. The private outcome is minted only by that transaction's locked prewrite rejection when no prior cursor exists, and escapes only after checked consuming close. Transport/finalizer/aggregate failures remain unknown; the marker is not retry or helper authority. Clients require an exact captured scope and fresh authenticated GET before releasing only that request's pending latch; no automatic POST follows.

Global status exposes approvalCode: "DOCKER_RESOURCE_REVISION_CAPACITY" only when the same actual approval predicate blocks capacity. Ordinary and pending-helper statuses omit it. An apply action may still adopt fresh matching native facts without reserving a new helper; the server distinguishes that path and reports a definite initial capacity refusal where necessary.

## Retained original attempts

An owner can inspect an original resource attempt independently of the current
employee, generation, binding, worker process, or latest desired revision. The
four owner-only endpoints are:

- `GET /api/company/docker-resources/original-attempts?after=<cursorId>`
- `GET /api/company/docker-resources/original-attempts/:cursorId`
- `POST /api/company/docker-resources/original-attempts/:cursorId/reconcile`
- `POST /api/company/docker-resources/original-attempts/:cursorId/retire`

Both POST bodies contain only `{expectedDigest}`. The historical approval owner,
immutable original key, and exact retained task supply the lookup and CAS scope.
The selector/digest is DATA, never authority. The collection contains up to64
pending attempts per page. Exact GET retains settled records, allowing a lost
reply to be checked without interpreting absence as success.

Reconcile inspects the original fixed high-only helper twice. It requires exact
historically issued image/configuration, capability, terminal PID0 state, and
no-restart/no-auto-remove protections. It never probes the old worker or claims
current memory enforcement. Retire is restricted to a preSTART cursor and actual
fixed created metadata, or observed absence. Its canonical CAS fences later
application dispatch; absence is not a terminal-writer proof. Existing original
task phases and unknown outcomes are retained unchanged. No endpoint starts,
stops, removes, or retries a helper/provider.

The immutable `original-closed` and `original-retired` journal variants contain
metadata-only receipts and cannot supply effective resource-policy proofs.
Pending helpers still block the owning approval until settled. New writes
revalidate original closed/retired metadata separately from fresh current-target
kernel/admission checks. No original receipt is converted into live policy
adoption. These new variants publish in journal version2; older readers that do
not recognize them refuse rather than strip history. Mutable settlement capacity
is reserved before helper intent, while these immutable final records retain
only their actual encoded size.
