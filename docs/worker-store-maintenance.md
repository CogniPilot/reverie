# Offline employee Nix-store preparation

`reverie-worker-store-maintenance` is an explicit ordinary-host-owner tool. It
prepares an **existing**, stopped employee's private Nix store for an already
selected and validated worker image. It never launches an agent/provider,
changes company data, wakes an employee, or creates a laptop container. Vacation
and desired-running flags remain unchanged. Normal Reverie startup does not call
this tool and needs no additional service or grants.

A successful receipt says `STORE_PREPARED`; `containerAdoption` remains
`NOT_RUN`. A retained stopped laptop still has its original image. The normal
next start may replace that container using the selected image. Store preparation
does not establish that a future provider, account or coding shell works.

An explicit target `validationScope: "VALIDATED_OFFLINE_IMAGE_TOOL_SHELL"`
instead qualifies an isolated image check. Its successful receipt says
`STORE_PREPARED_RUNTIME_ACCEPTANCE_PENDING`, with `runtimeAcceptance: "PENDING"`.
It never represents employee approval or a successful provider/runtime adoption.
Omitting the field preserves the existing current-agent validation mode.

## Qualification and private inputs

Run on Linux as the configured non-root broker owner with the normal local Docker
client. Use the installed Python console script, or run
`python -m reverie.worker_store_maintenance` in the native flake environment.
There is no sudo, host-OS activation, image build/pull/load, or service restart.

The config and qualification bundle must be canonical owner-only 0600 regular
files outside every configured or inspected container bind, the entire
`companyRoot` account-source namespace, and both employee storage namespaces.
This includes future cold-seat grants even when no container exists. The bundle is a
host operator's explicit qualification record, not a service grant or an
independent approval. Keep instance identities, actual receipts, paths and
image IDs outside the repository. Its closed JSON fields are:

- `version: 1`, `kind: "reverie.worker-store-target"`, immutable `imageId`,
  `engineId`, canonical local UNIX `engineSocket`, `validationContainerId`,
  `baseTarget`, future numeric `expiresAtEpoch`.
- Sorted unique `closurePaths`: top-level absolute Nix store paths from the
  qualified image's complete closure, including `baseTarget`.
- `cohort`: exact `{employeeId, sessionId, sessionGeneration, employeeDigest}`
  records, at most 32. The digest is `sha256:` plus SHA256 of the entire current
  employee object serialized with Python sorted keys, compact separators and
  ASCII JSON escapes. Every cohort employee must still be OFF and on vacation.
- `budget`: positive integer `fullClosureAllocatedBytes`, `overheadBytes`,
  `mainFloorBytes`, `scratchFloorBytes`. The model charges three complete copies
  per cohort employee plus overhead against fresh MAIN availability, preserving
  both floors. No GC, deduplication or reflink credit is taken. This is admission
  accounting, **not a quota or a filesystem reservation**; the operator must
  qualify the model and bound unrelated concurrent growth.
- `receipts`: `D2` and `CAN`, each `{path, digest}` to private actual validation
  envelopes. Both bind the same exact validation container and raw evidence
  digest and the same employee. Their data uses the existing closed D2/CAN
  receipt schemas (version, employee/container identity and raw path/digest,
  plus D2 jobs or CAN own-shell/probe fields). D2 requires the existing six
  named assertions in their fixed order, the managed Cargo shim and positive
  numeric jobs; CAN requires an actual own-tool-shell probe and its digest,
  managed shims, grep checks and completion. CAN's scope is explicitly
  `CURRENT_CODEX_TOOL_SHELL_ONLY`. Missing, changed or failed evidence refuses.
  The loaded image and its UID/GID/rootless capability metadata also pass the
  ordinary broker's image admission. The image's base link is read from the
  validation container without executing a command.

For the alternate offline-image scope, D2 data has exactly `version`,
`containerId`, `imageId`, `scope`, `rawEvidencePath`, `rawEvidenceDigest`, and
`jobs`. CAN replaces `jobs` with `probePath` and `probeDigest`. Both bind the
same exact image/container and `scope: "OFFLINE_IMAGE_TOOL_SHELL"`; neither claims `employeeId` or
`ownToolShell`. The same actual D2 assertions and CAN shim/grep/completion checks
still apply. The inspected validation container must use the configured ordinary
UID/GID, network none, a read-only root, dropped capabilities, no new privileges,
bounded RAM/tasks/CPUs, and private namespaces. Bind mounts cannot borrow employee
stores, accounts, private runtime destinations, sockets or devices; only `/output`
may be a writable bind. Retain this validation container, stopped or running,
through all preparation calls so its exact image, sandbox and base link can be
rechecked. Every cohort employee must still be OFF and on vacation.

The normal broker config's `image` must already equal this qualified target.
Otherwise a future normal start could undo the seed selection. A failed current
D2/CAN run cannot be used to construct a qualifying bundle.

## Plan and apply

First record a plan without mutations:

```sh
reverie-worker-store-maintenance --config "$broker_config" \
  --validated-target "$private_target" --employee "$employee_id" \
  --operation "$new_operation_uuid" > "$private_plan"
```

Review the exact plan and its `planDigest`, then use that digest with `--apply
--expected-plan-digest`. Do not retry an unknown operation with a new UUID.
Process one employee at a time and retain the resulting private receipts.
The CLI defaults to plan; there is no background activation.

Apply takes the **existing** stable employee storage flock and the existing
per-session Nix flock, refusing missing/replaced/held locks. It repeats exact
company/config/native admission while holding both. Before any engine mutation,
it fsyncs the employee's normal `.migration.json` fence, which the ordinary
broker already refuses across restarts and session aliases. This does not
change the employee's company migration record or any permissions.

The only new container uses the existing fixed Nix preparation helper: network
none, read-only image, all capabilities dropped, no new privileges, configured
ordinary UID/GID, 512 MiB RAM/swap, 128 tasks and one CPU. Only that employee's
private Nix store is writable; bounded tmpfs mounts are disposable. Optional
passwd/group binds are read-only. No home, account, workspace, provider socket
or model data is mounted. Cleanup addresses only the exact newly returned CID,
without force, and never deletes a container by name. Existing laptop containers
are retained. An existing helper, live alias writer, unexpected mount or unknown
engine state refuses.

Custody and writer checks compare physical device/inode ancestry as well as
canonical paths, including bounded nested mount points visible in the host
process's current mount namespace. They refuse bind aliases of private data or
control directories. They do not establish visibility into a different daemon
mount namespace; the operator must qualify that host/daemon topology. Fresh
expiry, exact config/target/cohort and capacity checks run directly before both
create and start, including after slow preflight or helper inspection.

Completion requires a successful exited helper, the full declared closure's
paths, the selected image GCroot and unchanged other profile/link metadata. The
observer reads metadata only; it never opens the Nix SQLite database. The helper
itself performs the same additive store/DB import as normal image preparation.
No database restoration or removal of additive imported paths is provided.

## Uncertain outcomes and limits

A timeout, nonzero helper exit, post-effect exception, cleanup failure or
identity/intent drift returns `UNCONFIRMED` and retains the employee fence.
Keep the helper and receipts for an explicitly reviewed reconciliation. Do not
unlink a fence based on a quiet scan, delete a helper by name, restore a database,
or automatically start an employee. Successful receipt durability precedes
fence removal; lock-cleanup uncertainty retains the fence too. A failing storage
filesystem can also make the fence's durability unknown and needs manual repair.

These checks do not establish that an old broker has no previously timed-out
Docker RPC still outstanding. First adoption must use a separately qualified
legacy-operation reconciliation or an explicitly reviewed maintenance boundary.
A quiet inventory is not daemon-completion proof. This command is not a daemon
maintenance boundary and does not claim engine-wide containment. Actual
execution remains unavailable until the selected target, model, custody and
legacy-operation prerequisites have been qualified for that deployment.
