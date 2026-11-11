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

This follows Docker's documented [bind-mount write semantics](https://docs.docker.com/engine/storage/bind-mounts/).
Docker's [container commit](https://docs.docker.com/reference/cli/docker/container/commit/)
pauses the selected container and excludes mounted-volume data, so an image
commit cannot provide this shared-data backup. Coordinated shared-writer
quiescence remains a product workflow requirement.

## Retained expert startup

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

Fresh native-worker generation/configuration transport is not qualified by the
local process adapter tests or by Office header-forwarding tests. Native
enrollment, durable launch reconciliation and uncertain canonical replacement
publication remain release blockers. Do not deploy this partial qualification
as proof of complete native employee recovery.
