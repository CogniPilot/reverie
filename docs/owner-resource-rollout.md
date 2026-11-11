# Employee laptop resources and rollout

The target workflow is **Company Settings → Laptop fleet**. The browser and an
explicitly authorized agent must use the same application API. The server owns
validation, capacity, rollout order, handoff, recovery and verification.
An image selection or saved resource policy alone is not an installed rollout.

## Current implementation boundary

The initial API exposes the current company roster and an explicit host-setup
blocker. It reports unknown image/controller observations and unknown operation
history as `null`. It does not create previews, operation IDs, perform host
setup, restart laptops or change policy files. Valid mutation requests return
`503 FLEET_HOST_SETUP_REQUIRED` until the authenticated host executor is joined.
An unavailable result never establishes that a previous operation is finished.

The current routes require a real unrestricted owner session; POST additionally
requires the console's own origin. Mixed agent/service/Goal/Authorization
credentials are refused. Guest accounts and organizational titles do not grant
permission. An appointed agent's scoped fleet authorization remains required
implementation work; these routes do not borrow a human owner's identity.

Host registration also needs a stable account incarnation: the legacy public
human ID `owner`, a username and a primary-owner flag cannot distinguish a
replacement account. New accounts receive an independent `accountId` UUID.
Existing accounts acquire it only through explicit unrestricted authenticated
enrollment under the existing account writer lock; reads never migrate them.
Enrollment preserves all other account fields. Shared-office registration
identity retains the actual ROOT office person ID and current session epoch;
an account-local child identity cannot promote a limited person.
Registration checks fresh canonical office roles, including external demotion
or removal, without changing legacy cached identity behavior. Sessions retain
their original credential fingerprint and optional incarnation; a legacy
session cannot adopt a replacement account merely because its epoch matches.
Only that session's own checked enrollment publication can bind its new UUID.
Account bytes are synced and the temporary descriptor closes before rename;
the existing policy-marker writer retains the parent-directory sync.

This identity is provenance DATA, not host-pool administration or enrollment
consent. Native registration must still retain the exact installation offer,
join fresh owner consent and check canonical revocation. No fleet route is
enabled by assigning an account UUID. The current native retained-offer and
canonical registration-consent integration remain required work.

The optional account field preserves the version-1 representation. The pinned
older account store reads JSON without rejecting extra fields and retains them
on read-modify-write; the message-owner schema also accepts extra fields.
Older whole-account replacement intentionally creates a different account and
may remove this field: registration then refuses until a fresh sign-in and
explicit enrollment establish a new incarnation. Older versions do not enforce new registration
grants; rolling back cannot be treated as an authorization-compatible executor.

Native installation website attestation has a separate `B` transport purpose
and `host-pool-registration-v1` hello. It shares the installed program, image,
kernel peer and process checks with RAM operations, but its distinct Rust owner
exposes only current-attestation checks and component closure. It cannot issue
an employee approval or journal authority. RAM's `Q` purpose still requires its
employee Gate. Neither channel can substitute for the other. This internal
attestation component does not enable a registration route: the actual retained
OS-owner offer, nominated account incarnation, fresh authenticated consent and
canonical revocation/publication checks remain required before administration.

## Shared API contract

Every route returns the ordinary `success`/`data` envelope, or a failure with
`success: false`. Responses are not cached.

| Route | Input | Meaning |
| --- | --- | --- |
| `GET /api/company/resources/fleet` | None | Capabilities, blockers, complete company roster, desired/observed settings, offered images and host operation history |
| `POST /api/company/resources/fleet/preview` | Expected revision, offered target image, employee policies, pool, canary and handoff | Validate and bind the exact requested fleet change; currently setup-required |
| `POST /api/company/resources/fleet/apply` | Preview ID and expected revision only | Attempt the previously reviewed plan once; currently setup-required |
| `POST /api/company/resources/fleet/result` | Operation ID only | Observe the actual host-owned operation; currently setup-required |

The closed TypeScript schema is
[`resource-fleet.ts`](../apps/web/src/types/resource-fleet.ts). Image references
must resolve to immutable server-offered artifacts before execution. IDs,
revision strings and JSON status fields are references, never execution grants.
Requests cannot supply host paths, programs, Docker arguments or observations.

`memoryHighMiB` means cgroup `memory.high`: reclaim/throttling pressure.
`memoryMaxMiB` means its separate hard ceiling. `cpuWeight` means relative
burstable CPU sharing, not a hard CPU quota. Allowed CPUs constrain placement.
Perf availability requires the image tool, selected task policy, host support
and a real successful profiling check. Docker's memory reservation is not
verification of `memory.high`.

For the shared parent, a required `memoryHighMiB: null` means a known unbounded
soft threshold (`memory.high=max`); the finite `memoryMaxMiB` still applies.
An entire `pool.observed: null` means the pool has not been verified. Missing
threshold fields do not mean unbounded. Employee requested soft thresholds
remain finite and below their hard ceilings. Legacy finite parent thresholds
retain their existing representation and editor.

## Host executor acceptance still required

The rollout target is the repository-packaged Rust controller running in Docker,
with instance settings beneath the registered `~/reverie` root. It must derive
and verify its Docker-managed pool rather than install a host slice or edit
another repository's NixOS configuration. The existing NixOS memory helper is a
legacy alternative; it does not provision this pool or establish rollout readiness.
The existing image-switch tool requires a stopped broker and fleet and explicitly
does not recreate employees. The console update service updates only the console.
None of those component outcomes is a complete fleet rollout.

The host executor must bind its actual registered installation and current
employee/session/image/policy identities; preserve existing homes, memories,
plans, conversations and Nix stores; retain offline/vacation dispositions; and
journal a real canary followed by the remaining selected employees. Resource
readback and perf tests are per-incarnation acceptance. Unknown effects remain
fenced across process/browser restarts and must not be automatically replayed.

The aggregate pool must leave enforced CPU/RAM/task/swap capacity for the
website, control services and recovery. A capacity calculation or settings save
is not that enforcement. See [SPEC_0001](../spec/SPEC_0001_OWNER_OPERATIONS.md)
and [soft RAM setup](laptop-soft-limits-and-swap.md).

For the selected 48 GiB pool, every employee may borrow up to the pool's full
48 GiB hard ceiling. An employee's smaller `memory.high` threshold controls
pressure without reserving or hard-partitioning that amount. The aggregate
parent enforces the shared limit. All previous workers outside that parent must
be stopped and their operations settled before the first such burst worker can
start; counting their limits in a preview cannot enforce an aggregate ceiling.
The executor must fence the previous provider throughout this handoff.

The migration preserves the source session's complete resource and memory
policy in a versioned session record before selecting the target policy. The
approved intent must bind that exact target policy, including soft RAM and
swap settings. A publication receipt proves the actual configuration commit;
it is not permission to launch or evidence of applied kernel limits. Created,
started, ready and settled are separate native outcomes. Lost replies or
unconfirmed effects retain the original operation and forbid automatic replay.

## Never-issued preview history

An original version-one `prepared` operation at sequence zero proves that native
migration consent was never dispatched: the writer must durably commit `issued`
before invoking the native migration client. When that preview expires or loses
its connection, its current enrolled owner may end it and request a new review.
After a web-process restart, the same prepared record can be ended from its
durable no-dispatch evidence. These transitions use the private store's checked
compare-and-swap and current authorization; uncertain writes still block changes.

The terminal record explicitly uses version two, purpose
`fleet-migration-operation-v2`, phase `not-issued` and sequence one. It preserves
the original preview, principal, owner scope and cohort, contains no native
result, native failure, employee restoration or pool-absence receipt, and has no
outgoing transitions. The reader supports unchanged version-one history and
this one version-two terminal state. Existing version-one records are not
silently normalized. Older writers cannot read the version-two state; rolling
back requires a compatible reader rather than rewriting or deleting history.

This state proves no migration dispatch. It does not prove that the broker
released the old preview hold, that the pool is installed or absent, or that any
employee is running. A new review may still report a host-side pending preview
until its original hold is released or expires. Issued or already unknown
operations remain unknown and fenced; they cannot use this transition even when
they have no recorded native response. Recovery of an unknown operation while
the pool remains installed is a separate unresolved workflow.

## Native integration work

The [native integration map](rust-overhaul.md#native-integration-map) names the
existing Rust owners and the RAM-v2 client. Reuse those components. The client
does not activate these fleet routes, and its per-employee approval cannot
implicitly authorize a fleet-wide stop. The fleet preview must bind the complete
selected cohort and preserve every employee's desired-running disposition.

The new Docker parent needs separate admission accounting. Existing reservation
operations charge hard memory and require a finite parent soft threshold; they
cannot establish parent-once accounting for this borrowing pool. Preserve their
records and contracts. The new transition must own a durable provider fence on
the existing pending-control boundary, including across storage waits, Nix work
and broker restarts. Reconciliation must reobserve the original native owners
before acknowledging settlement; an empty census or dropped local handle is
insufficient.

Only after old outside workers have physically settled may the executor admit a
borrowing leaf. Its actual created record must retain verified parent membership,
incarnation and kernel limits before normal pane startup. Keep stopped/absent
preparation separate from running-source preparation. A configured policy,
successful isolated test or closed socket cannot substitute for any of those
ownership joins or the final pressure/recovery acceptance.

Member configuration retains a maximum of 256 attempted container identities.
Deadline, duplicate, capacity and member-policy checks run before native
observation or admission of another identity. Their closed `memberRefused`
reply rejects only that request; it does not retain a controller-wide primary
failure or clear uncertainty from an earlier request. The broker accepts this
outcome only from its original authenticated exchange with the exact request
nonce and current controller identity. Older, malformed or unconfirmed replies
remain fenced, as do failures after native observation or configuration begins.
Correlating a refusal does not clear the broker's actual uncertainty flag: the
same owner rechecks current native identity first, and a failed guard leaves
that flag retained. The reply's closed anchor observation is data only.
Observation and policy-edit preflight remain available when new-member capacity
is exhausted.

This isolation does not recycle the attempted identities or implement turnover.
Retirement needs the original confirmed stopped-laptop removal, exact fresh
container absence and known closure of every retained member component. The
controller has no such receipt-consuming retirement operation yet. Count, age,
desired employee state and a parsed absence DTO cannot free a slot. A positive
native turnover/edit sequence still needs the owned controller integration
fixture; metadata-only preflight tests do not establish that acceptance.

## Fleet reply codec compatibility

The fleet Q handshake requires `replyVersion: 2` and the native
`FLEET_MAINTENANCE_CHANNEL_V2` greeting. Update the website and native broker
together. Missing or unsupported codec negotiation is refused before preview,
consent, handler interruption or pool publication; there is no version-one
fallback. Persisted version-one operation data and reply JSON retain their
existing schemas. Package provenance is not proof that an older website/broker
pair supports this codec.

Incoming requests, owner checks, pool registration and ordinary resource replies
remain limited to 8 KiB. Only the closed fleet preview/result output type has a
64 KiB budget. The maximum supported provider registry remains 64 employees;
the pool policy may separately retain 256 employee thresholds. A maximal valid
policy with 4,096 CPUs, a 4,096-byte escaped instance path and 64 restoration rows
encodes to 63,543 bytes in the contract regression.

Before interrupting handlers or draining employees, the coordinator encodes and
validates all variable-length result fields from the original approved policy
and restoration cohort. Publication then fills only the two fixed-width digest
slots from its actual configuration and control-domain receipt. This prepared
reply is data; it neither authorizes effects nor establishes that publication
or employee recovery succeeded.

## Perf qualification boundary

The explicit native image test is
`cargo xtask verify-worker-perf --rootless-image ... --task-perf-policy task-v2`.
Its help lists the immutable image, provenance, policy and closure inputs. It
checks physical outer-container limits, nonroot software `task-clock:u`
counting and inherited recording with positive samples, and a native inner
rootless Docker workload. The inner workload is not itself profiled and does
not establish inner cgroup delegation. Task-v1 retains its original restrictions;
its inherited-recording refusal is not a successful capability check.

This developer fixture mounts its reviewed test executable. It is not yet the
production check for each employee incarnation. The rollout must package a fixed
Rust checker in the offered worker image and bind its actual result to the same
Created/start/memory workflow before pane startup. A successful fixture, selected
policy or installed perf executable cannot replace that per-incarnation result.
