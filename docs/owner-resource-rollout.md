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
