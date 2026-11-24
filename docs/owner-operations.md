# Owner operations

The canonical architecture and implementation gaps are in
[SPEC_0001](../spec/SPEC_0001_OWNER_OPERATIONS.md).

The [employee resource rollout API](owner-resource-rollout.md) documents the
shared GUI/API contract and its current host-installation blockers.

See the [specification index](../spec/README.md) for DRY, crate boundaries,
valid-by-construction contracts, review and workflow rules. The
[Rust overhaul inventory](rust-overhaul.md) tracks migration work.

Console deployment previews and the final pre-stop check refuse observed writable
mounts from other running containers that overlap the console data, including
parent paths and resolved symlink aliases. `DEPLOYMENT_SHARED_WRITABLE_MOUNT`
means the shared writers need coordinated lifecycle maintenance before a fresh
preview. The updater never stops those writers implicitly. This early check is
an observation, not a whole-host writer-exclusion guarantee; the existing byte,
metadata and restore-rehearsal checks remain required.

An outside-product replacement can leave a terminal active claim pointing at two
containers that no longer exist. The local owner may explicitly select
`preview --adopt-stale-claim OLD_OPERATION --expected-current-container FULL_CID`
alongside the existing image/profile/network/writer selections. Format 6 records
the old immutable READY/candidate/plan and the selected current website. It does
not turn that old READY receipt into current readiness. Both old exact CIDs must
return authenticated complete Engine 404 responses; the current registered
website must pass fresh configuration, init-incarnation, bind custody, native
process-tree and status checks. The three declared data/home/workspace bind
grants must agree; this does not prove old inode or data continuity.

Preview only freezes the selection. Prepare repeats the observations after
archiving the active claim, before atomically handing it over under the original
installation lock. Old records remain intact. Any uncertain handover or receipt
failure holds the original attempt before candidate creation; inspect its status
and retained records rather than submitting another operation or editing claims.

This follows Docker's documented [bind-mount write semantics](https://docs.docker.com/engine/storage/bind-mounts/).
Docker's [container commit](https://docs.docker.com/reference/cli/docker/container/commit/)
pauses the selected container and excludes mounted-volume data, so an image
commit cannot provide this shared-data backup. Coordinated shared-writer
quiescence remains a product workflow requirement.

## Employee disk budget

Every employee has a fixed disk budget of 20 GiB for their case folder, the
working directory of their saved session under the shared cases directory. Case
folders hold cloned git repositories only. Useful work is pushed to GitHub.
Anything kept permanently needs the owner's approval and goes on the shared
company drive. The shared Nix store does not count against the budget.

The office measures each registered employee's case folder every 30 minutes,
starting about five minutes after it boots, one folder at a time with a
low-priority `du` limited to that filesystem and to ten minutes. A folder is
measured only when it is a real directory strictly under the cases directory;
a symlinked, missing or unreachable folder, a failed or timed-out measurement
and an employee whose cases live elsewhere (per-user case spaces in multi-user
mode) read `unknown`, never empty. Entries `du` cannot read are left out of the
total, so a reported size is a lower bound.

An employee over budget is told in their own session, as one typed prompt, to
clean up. The notice is sent when the folder newly goes over and then at most
once every six hours while it stays over. It is typed only into a live session
that is idle, not held and showing no dialog; otherwise the office tries again
on the next cycle. Employees on vacation or stopped are measured but not told.
Measurements and notice times are held in memory, so a restart measures again
and repeats the notice for an employee still over budget.

`GET /api/company/disk-budget` (owner only, read-only) returns the budget and,
per employee, `usedBytes`, `measuredAt`, `state` (`ok`, `over` or `unknown`) and
`lastNotifiedAt`. There is no write endpoint and the budget is not yet
configurable.

Current gaps: only the case folder is measured. An employee's private home and
scratch storage are not measured and do not count yet, nothing is deleted or
blocked automatically, and the owner is not alerted separately.

## Employee group CPU ceiling

All employee laptops of one office run under one pool cgroup,
`reverie.slice/reverie-box.slice/reverie-box-<box>.slice`. The owner can approve
a ceiling on the CPU time they use together, in whole CPUs. It is the pool's
kernel `cpu.max` (`<CPUs x 100000> 100000`), separate from every employee's own
resource policy, so approving or changing it alters no employee policy, digest,
acknowledgement, container or session.

`GET /api/company/docker-resources/cpu-ceiling` (signed-in owner only) returns:

- `approved`: the owner's current decision (`revision`, `cpuCores`, `cpuMax`),
  or `null`. `cpuCores: null` means the owner chose no ceiling.
- `proposed`: a suggestion for the approved pool CPU set, three quarters of its
  CPUs and always at least four left free (24 of 32). It is never applied by
  itself.
- `effective`: what a fresh read-only pool observation shows the kernel
  enforcing, or `null` when the pool could not be observed (`code` says why).
- `state`: `unapproved`, `pending` (approved, the kernel still shows none or an
  earlier approved value), `applied`, `drifted` (a value the owner never
  approved) or `unobserved`.

`PUT /api/company/docker-resources/cpu-ceiling` (signed-in, same-origin owner;
no worker, parent-session or service-token header) records a decision:

```json
{ "revision": "NEW_UUID", "expectedRevision": null, "scope": "all-employees", "cpuCores": 24 }
```

`expectedRevision` is the `approved.revision` the owner last saw, or `null` for
the first decision. A stale value is refused with
`DOCKER_POOL_CPU_CEILING_CHANGED`; repeating the identical request is accepted
once. A value above the pool CPU set is refused. Decisions are appended to the
private `docker-pool-cpu-ceiling.jsonl` beside the company store.

Recording a decision changes nothing in the kernel. Pool checks accept "no
quota" or a ceiling the owner approved (the current and the seven before it),
so a pool carrying an approved ceiling stays acknowledged; any other pool quota
is still an unapproved change. A worker's own cgroup never has a quota.

Current gaps: the office does not yet issue the write. The fixed helper has the
command (`configure-pool-cpu-max`, which writes only `cpu.max` on a populated
pool after the usual identity checks and keeps every laptop running), but no
helper image carrying it is selected in the runtime manifest and no apply
endpoint exists, so `state` stays `pending` after approval. There is no GUI
control. A host restart recreates the pool cgroup without a ceiling.

## Retained expert startup

After a reboot, the ordinary session restore banner and its API offer personal
sessions. The company lifecycle service owns recovery for employees, including
employees on vacation. Retired employee sessions stay out of the offer. The
automatic pinned-session restore checks this same boundary again before launch
in case an employee acquired the session after the offer was created.

The template-hiring API keeps employment (`active` or `retired`) separate from its
startup journal. New hires move from `prepared` to a durably recorded `issued`
before launch. `launch-returned` means the launch adapter returned; it is not
evidence that an employee is online or ready. A rejected launch keeps the same
employee, session, generation, rooms and hire record as `recovery-required`.
An identity-binding or pre-launch refusal can leave `not-issued`; it does not
authorize another launch. Notice and audit confirmations are reported separately
and never cause a launched employee to be deleted or stopped.

Owner-approved requests retain a closed creation reservation before invoking
session creation. `creation-issued` carries no SID and makes no claim that a
session exists; only `session-bound` carries the actual returned SID before
canonical employee creation. An unresolved reservation counts against
capacity. A linked approval cannot be approved again or declined to reset its
startup. Inspect `GET /api/experts` and the employee profile; use only existing
explicitly authorized recovery workflows. This journal neither enrolls a new
employee into an already-installed native pool nor grants resource authority.

The experts store reads version 1 records as `legacy` without inventing a launch
receipt. The next confirmed write uses version 2. The previous version-1 reader
rejects version 2 on a fresh load, but a previously loaded old process can cache
version 1: migration requires a single stopped old writer and one new writer.
Do not run an older console concurrently or downgrade it over the version-2
store. There is no cross-process CAS in this store.

A write rejection may occur after rename. An exact private authority refusal
from the canonical writer's pre-rename callback proves that publication did not
occur and leaves the writer usable. Other write failures remain ambiguous. The current process blocks further
hiring writes and session creation rather than overwriting disk with its older
cache. A fresh process reads the stored journal without replaying startup.
Cross-store creation is not atomic: session creation without a returned SID,
or canonical creation before its first hire-record write, can still require
supported reconciliation or idempotent creation. An empty current list cannot
clear or replay an uncertain creation. No SID, missing record or reservation
is treated as absence proof, launch permission or native enrollment authority.
Hire diagnostics and requests are filtered by exact owner scope, including the
template detail route. Missing legacy owner values remain unscoped; they are not
assigned to a named owner. Templates, settings and capacity limits remain
instance-wide, so global quota counts can exceed the caller's visible hire rows.
Both owner and delegate template hires carry a private, revocable creation fence
through the ordinary authenticated session API. The exact request, payload and
owner remain bound across preparation and the layout lock; owner credentials
are not replaced with delegate credentials. A refused, unregistered Session
disposes local trackers without provider or mux signals. An error response never
authorizes destructive cleanup of a returned session ID.
Template hires recheck the same admission predicate, original Session object and
owner inside the canonical company-store lock and again before employee-record
publication. Room invitations are awaited and any failure is observed before
startup; they do not trigger deletion of the published identity.

## Unconfirmed provider dispatch and held approvals

Mandatory workspace-hook preparation must finish before a provider launch. A
successful file write is configuration evidence, not provider readiness. The
local process adapter reports a separate dispatch boundary; a positive PID
without that boundary does not prove a successful launch. If dispatch may have
occurred but completion cannot be confirmed, the Session retains its attempted
configuration and exposes `providerDispatchHeld: true` in its state. That field
is a persisted denial, not a capability: omitting it or sending `false` cannot
clear the private hold on an existing Session. Automatic retries and ordinary
input are refused. Read-only viewer attachment remains separate.

The original employee/conversation launch reservation becomes nonexpiring while
dispatch is in progress or unconfirmed. A predecessor cannot release a newer
reservation. These reservations currently live in the console process; durable
before-dispatch journaling and crash reconciliation are still required. Inspect
the existing terminal and preserve the original Session identity. There is no
supported same-Session API to clear this hold. Restarting the console is not
proof that the original provider stopped and does not authorize replay.

`GET /api/approvals` and approval SSE events project `answerState: current` or
`answerState: held`, with a diagnostic `heldReason`. The server binds answer
authority to the original Session, provider epoch and owner account; the GUI
does not grant that authority. An answer that may have reached the terminal
stays held rather than being automatically resent. Human clients retain their
draft and disable answer buttons; API clients must inspect the conflict and
wait for a genuinely current prompt. Refreshing an inbox cannot certify an
unconfirmed answer as safe to repeat.

## Unconfirmed canonical replacement publication

Candidate cleanup on a failed replacement carries the original in-process
Session, owner, local transport record and PID identity through storage waits,
the owner layout lock, and process termination. Losing that identity refuses
cleanup; it does not authorize stopping a successor with the same session ID.
An unproved native/remote/container stop also refuses before changing running
intent. The API reports `candidate-cleanup-unconfirmed`, retains the original
replacement claim and intent, and requires recovery rather than replay.
Guarded cleanup preserves optional workspace/upload/subagent artifacts instead
of deleting them by session ID. It signals only the original verified local
process identities, requires observed pane death or absence, and preserves any
dead tmux pane rather than killing a potentially reused name. Live or unknown
readback requires recovery. This does not add native stop/reconciliation
authority or qualify the older unguarded cleanup paths.

Canonical employee replacement distinguishes a refusal before its current
rename was issued from an uncertain rename or later publication failure. The
current writer is held after uncertainty; it cannot overwrite the stored
binding from its previous cache. A known authority refusal before rename does
not poison that writer. This fence belongs to one process and is not a
cross-process exclusion or durable reconciliation journal.

Once a binding reservation has been published, a later room, validation,
publication or identity-notification error cannot authorize deletion of the
replacement Session, restoration of an older binding or rollback of running
intent. The API returns a conflict with `recoveryRequired: true`,
`reason: binding-publication-unconfirmed` and the original employee/session
identifiers. These are diagnostics: only the actual private service attempt
and original Session can produce the retained outcome. An obsolete attempt
never overwrites a newer Session or owner while persisting diagnostics.

A plan move receiving this conflict stays `recovery-required`, even when
creation did not return a candidate SID. It does not invent that SID, stop a
candidate, restore an old binding or offer another move. Human and headless
clients must preserve the operation and inspect the existing state. Supported
canonical binding reconciliation is not implemented. A restart, a fresh cache
or a readable row is not proof that an uncertain operation may be replayed;
coordinated old-writer exclusion and durable reconciliation remain required.

Fresh native-worker generation/configuration transport is not qualified by the
local process adapter tests or by Office header-forwarding tests. Native
enrollment, durable launch and canonical binding reconciliation remain release
blockers. Do not deploy this partial qualification
as proof of complete native employee recovery.

## Docker continuation correlation format

Version 2 keeps the original launch fingerprint and approved request unchanged,
and adds a separate fingerprint for observations of an existing provider. Only
the shipped native-thread codecs may omit runtime-owned conversation IDs from
that observational fingerprint. Owner, account, session generation, working
directory and provider configuration remain part of the binding. A fingerprint
never grants launch authority or replaces fresh container and native-process
identity checks.

Startup imports a version 1 record through the canonical company writer only
when its original fingerprint can still be reproduced. The narrow first-learned
Codex thread case also requires reproducing the exact original launch bytes;
unknown previous thread IDs are not guessed. This format import preserves the
request, resource approval, operation, credential, binding, phase and launch
fences. Each employee is migrated inside its own viewer-restoration boundary,
so a stale record remains held while unrelated viewers can reconnect.

Existing-provider correlation resolves an absent Claude permission mode through
the unchanged shipped protocol's selected default. Explicit permissions and tool
selections remain distinct; unknown or overridden protocols retain strict
comparison. Actual Session facts use a complete projection without view/runtime
getters, so checking a proof does not recursively invoke its serializer. The
original launch fingerprint remains unchanged and is still an additional check
before the first provider launch.

Both formats have explicit strict schemas. An older reader that does not
understand version 2 must refuse the store; it must not discard records or load
an older backup over them. Do not run competing old and new writers or downgrade
the data format by editing private files. These source contracts and synthetic
startup tests do not establish acceptance of a deployed image or grant recovery
of an uncertain paid launch.

## Reconcile a missing shared Docker pool acknowledgement

A completed pool helper can outlive the employee that originally owned its
journal row. The supported metadata-only observation path is
`GET /api/company/employees/:id/docker-pool/status`. A verified owner or an
agent with a current explicit `recoverEmployees` grant may inspect it. Existing
approved pool policy is required; this operation cannot approve or edit limits.

When the response offers `reconcile-pool`, submit
`POST /api/company/employees/:id/docker-pool/reconcile` with the returned
`sessionId`, `sessionGeneration` and `expectedScopeDigest` copied from
`scopeDigest`. The server repeats fixed-image/configuration, original successful
native log ACK, current anchor PID/birth, parent identity and pool-policy checks,
then records only global observation metadata through the canonical company
writer. It never creates or starts a helper, changes limits, launches a provider,
or clears an employee launch fence. No retired employee/session/origin UUID is
invented from helper labels. Multiple original successful helpers are accepted
when every discovered writer is fixed and terminal. An earlier epoch's ACK must
match a retained receipt for the same pool and policy. The current observation
requires a fresh ACK for the current native epoch. One verified task is selected
as new observation correlation, preferring an already retained proof; this is
not a claim about which historical operation caused the pool state.

`retained` reports the observation record, not permission to launch. Every
later resource use still needs its own fresh native proof. Running/unknown
writers, ambiguous or foreign helpers, changed epochs, missing original logs,
revoked authority and stale previews remain held. Unknown publication is not
silently retried. After restart, obtain the canonical record and original native
proof again.

Canonical company format 2 is published atomically when either retained pool
lineage or a re-earned observation becomes nonempty. Empty legacy format 1
remains readable; format 1 containing new retained pool metadata is rejected.

## Recover the shared Docker pool after a host restart

Open Docker resources for an employee whose shared pool anchor is unconfirmed
and select **Review stopped pool recovery**. The verified owner can also call
`GET /api/company/employees/:id/docker-pool/cold-preview`. The preview checks the
exact stopped anchor, the approved shared policy, the selected workers and the
original resource writers. It is available when the worker pool is empty and
the prior writers can be accounted for.

Confirm with `POST /api/company/employees/:id/docker-pool/cold-recover` using a
new UUID as `operationId`, the returned `sessionId` and `sessionGeneration`, and
the returned `scopeDigest` as `expectedScopeDigest`. The backend starts the
existing anchor and uses the native helper to apply the previously approved
limits. It commits the new pool observation after fresh kernel readback. The
employee session remains under its original recovery operation.

The backend records the attempt before starting the anchor and records each
helper action before issuing it. If an outcome is uncertain, subsequent effects
stay held under the original operation ID. `retained` reports fresh pool proof.
Use the employee's existing recovery operation to continue its session.
Once format 2 is published, this writer refuses downgrades even if the arrays
later become empty. Older literal-1 readers must refuse the entire store rather
than strip fields. Do not run old/new writers together or restore an older backup
over current company data. This envelope upgrade does not change any employee,
session, binding, approved resource policy, operation or launch fence.

## Reprovision a laptop whose containers are absent

Use this when an employee's recorded Docker containers no longer exist in the
Engine, for example after an operator prune removed stopped containers. The
employee ID, session ID, generation, memories, approved resource policy,
private HOME/Nix directories and provider conversation are kept. Only the
container is replaced. Employees are never recreated or rehired.

The workflow is owner-only: a signed-in, same-origin owner request without
parent-session, worker-identity or service-token headers. No agent permission,
title or CLI reaches it. The GUI has no control for it yet; an authorized
headless client uses the same API.

Preconditions, checked at preview and again at confirmation:

- The employee exists once, is in the office, wants to run, and has no binding
  migration, pending owner stop or open recovery operation.
- One continuation record exists for the current session and generation.
- An Engine listing returns none of: the record's original and destination,
  the employee's bound container, a plan replacement's source container, any
  container labelled `reverie.boxed.employee` for this deployment, and any
  labelled `reverie.employee` for this deployment. A failed or errored Engine
  call is unknown, never absence. If anything exists, running or stopped, the
  request is refused and the ordinary recovery workflows own the laptop.
- No continuation is in flight. No plan move is being dispatched. An open
  native (Docker) plan move for the employee is closed by this operation; any
  other open move is refused.
- The saved session exists. Its boxed view, if any, names one of the absent
  containers. Its launch denial, if any, is a boxed (`docker`) launch with no
  live owner.
- A qualified source image is present: the manifest worker image, otherwise a
  listed source image.
- One per-worker office API network labelled `reverie.boxed.employee` for the
  employee survives with exactly the office attached. This workflow creates no
  network; deployment tooling owns those bridges.

Calls, in order, for employee `EID`:

1. `POST /api/company/employees/EID/docker-absent/preview` with
   `{ "template": TEMPLATE }`. It returns `mode`, `reason`, `sessionId`,
   `sessionGeneration`, `record`, `absent`, `present`, `account`, `home`,
   `nixSource`, `scratchSource`,
   `sourceImageId`, `network`, `networkCandidates`, `planMoves`,
   `templateDigest`, `scopeDigest` and `allowedActions`. It changes nothing.
2. `POST /api/company/employees/EID/docker-absent/reprovision` with
   `{ "operationId": NEW_UUID, "sessionId", "sessionGeneration",
   "expectedScopeDigest": scopeDigest, "template": TEMPLATE }`. It returns
   `{ operationId, state, code?, sourceContainerId?, sourceImageId? }`.
   `ready` means the record is retired and one stopped source laptop exists.
   `held` names the refusing step; send the same body again to resume.
   Before the source is created, the worker image's own networkless
   `reverie-nix-store-prepare` helper additively imports that image's closure
   into the Nix store, as the legacy broker's image preparation did; without
   it the image's tools are dangling links behind the store bind. The first
   call can therefore take a few minutes.
   Every reprovisioned laptop mounts one shared store, `<stateRoot>/nix`
   beside the `employees` directory, instead of a private store beside its
   home. The owner creates that directory once, owned by the laptop user.
   Laptops must not collect garbage in it: each laptop's profile roots live in
   its own home and are invisible to the others. The shared store counts
   against no employee's disk budget.
   A record that requested its destination lists its recorded containers under
   `discard` and still allows `reprovision`: each is removed, never by
   force, only when it is stopped or the Engine shows it hosts nothing beyond
   its own init. A laptop with a live provider is refused; stop it first. Home
   and scratch are binds and are kept.
3. `GET /api/company/employees/EID/docker-policy`. It now reports
   `state: "stopped"`, `operationId: null`, the new `containerId`, `imageId`,
   `destinationImageId`, `policyDigest` and `allowedActions: ["continue"]`.
4. `POST /api/company/employees/EID/docker-continuation` with
   `{ "request": { "operationId": ANOTHER_NEW_UUID, "sessionId",
   "sessionGeneration", "containerId", "imageId", "expectedPolicyDigest":
   policyDigest, "expectedDestinationImageId": destinationImageId,
   "enterOffice": false } }`.
5. `POST /api/company/employees/EID/docker-continuation/observe` with
   `{ "operationId": ANOTHER_NEW_UUID }` until `state` is `ready`. A `held`
   result with `allowedActions` containing `continue` is advanced by repeating
   call 4 with the same body. An unknown outcome is never repeated.

`TEMPLATE` is the owner-approved shared-drive layout:

```json
{
  "user": "1000:1000",
  "scratchRoot": "/HOST/SCRATCH/laptops",
  "mounts": [
    { "source": "/HOST/DRIVE", "destination": "/reverie_workspace", "readOnly": false }
  ],
  "workspaceAlias": true
}
```

`user` is a non-root `uid:gid`. `scratchRoot` must be named `laptops`; the
laptop receives `<scratchRoot>/employees/<employeeId>` as `/scratch` and its
`tmp` child as `/tmp`. Mount targets are limited to `/reverie_workspace`,
`/workspace`, `/projects`, `/projects/<name>` and the read-only operator set
`/host-published`, `/instances/default/tools`,
`/instances/default/console/statusline-exporter.sh` and `/run/reverie-model`.
Paths are absolute and normalized. Targets are disjoint. `workspaceAlias`
mounts the `/reverie_workspace` drive at `/workspace` as well. `network` names
one of `networkCandidates` when the preview reports more than one. The backend
derives HOME from the retired record and Nix from its sibling `nix` directory;
a template cannot name private storage, `/proc`, a worker capsule or an Engine
socket, and no drive may overlap the employee or scratch directories.

Effects of a confirmed request:

- An open native plan move is closed as `failed` with a `dockerAbandonment`
  record naming this operation. Its journal is kept verbatim and is immutable.
- One CompanyStore transaction moves the continuation record and the published
  binding verbatim into `retiredDockerEmployeeContinuations` and removes them
  from the employee. This history is append-only and publishes company format 2.
- The state service removes the saved session's stale boxed view, the holds
  that view carried and its boxed launch denial. A stopped viewer object for
  the session is discarded. Mode, working directory, model, recipe, thread and
  resume fields are unchanged, so the provider resumes the same conversation.
- The create intent is recorded, then one stopped container
  `reverie-boxed-source-<digest>` is created and its ID recorded. It uses the
  inert worker init, no command, the template user, a read-only root, no
  capabilities, `no-new-privileges`, no restart, no device request, no secret
  and no Engine socket. It is never started. The destination is built from it
  by the ordinary continuation, which adds the GPU profile and resource limits.

A lost create reply leaves the operation `held`. Repeating the same request
lists the source by its labels: an existing source is verified and recorded; a
create is issued again only when the Engine positively lists none. A repeated
request after `ready` returns the recorded result without Engine access. A
different operation ID then previews as a source replacement, described below.

### Provider account routing

The backend derives the source's account routing; a request cannot choose it.
The preview reports it as `account`, and it is part of `scopeDigest` and of the
journal entry.

- `generation-env`: the employee's first retired record was a plan
  replacement. The source carries one variable, `CLAUDE_CONFIG_DIR` (Anthropic)
  or `CODEX_HOME` (OpenAI), set to
  `/home/agent/.reverie/plan-moves/<retired operationId>/generation-<projectionDigest>/<claude|codex>`
  inside the private home. No mount is added.
- `seat-mount`: the saved session's launch overrides, clamped as the provider
  launch clamps them, set `CLAUDE_CONFIG_DIR` or `CODEX_HOME` to
  `/instances/default/console/accounts/<id>` and `<id>` is the employee's
  current subscription profile. The source receives one read-write bind at that
  exact path. Its host directory is `<home>/.reverie/seat-auth/<id>`, or the
  template's `accountSource` when given; the directory name must be `<id>`. The
  variable is not added to the source, because the launch supplies it. This is
  the only writable path under the accounts root; `mounts` cannot name one.
- `none`: neither applies.

An override that names another profile, two seat overrides, or an
`accountSource` with nothing to route is refused.

### Replace an unused source

The same two calls replace a source that was never started, for example one
created before account routing existed. Use a new `operationId`. The preview
reports `mode`:

- `replace-source` (`reason: "source-replaced"`): the employee's newest journal
  entry is complete and no continuation record exists.
- `retire` with `reason: "source-superseded"`: one version 2 record was begun
  from that source and never requested a destination (`staged` to
  `pool-ready`, no destination, no binding, no saved boxed view). The record
  moves verbatim into the journal entry.
- `retire` with `reason: "recorded-containers-absent"`: the case above.

For both replacement reasons the Engine must list exactly one container for the
employee: the recorded source, with its recorded name, operation label, image
and network, in state `created` with no start time. Any other container
labelled for the employee, a started source, a later record phase, an open
plan move or a storage holder the journal does not own is refused. The preview
adds `previous: { operationId, sourceContainerId }` and `helpers`.

Effects: a new journal entry naming the previous operation is recorded first.
Then the old source is removed by ID, without force, and only while the Engine
still reports it never started. Then the new source is created as above. A lost
removal reply is settled by listing: an absent source is recorded as removed, a
present one is re-proven unused before removal is requested again.

A superseded record's storage holder (`reverie-boxed-storage-<digest>`,
labels `reverie.box.storage.*`) and exited ephemeral helpers
(`reverie-boxed-ephemeral-<digest>`, labels `reverie.box.ephemeral.*`) are left
in place. No existing workflow stops a storage holder, so this one does not
either. A holder keeps read-only directory handles and its name belongs to the
retired operation, so the next continuation creates its own. The shared pool
anchor and pool helpers are not touched; their lineage stays in
`dockerSharedPoolLineages`.

This workflow never starts a container, launches a provider, edits a resource
policy, creates a network, deletes journal history, or changes an employee's
identity, session, generation or account. It removes only a never-started
reprovision source. Rebuilding deleted worker images is separate. Installed
qualification on a real Engine is still required.
