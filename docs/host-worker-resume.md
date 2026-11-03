# Host-owner fleet resume

`worker-resume` is an optional packaged, owner-local caller for the existing
worker socket. It has no HTTP endpoint and accepts no commands, recipes, owner
assertions or employee tokens. The broker checks actual host UID, namespaces and
process birth, including the credentials of the process writing each frame.

The matching website registers a distinct `host-worker-resume-v1` stream. Its
complete immutable console graph, fixed Node invocation, native configured
website and code ancestry are checked by the broker. The website independently
requires the existing read-only worker-socket directory mount and retains the
actual socket identity for the stream. OwnerAuth and protected H remain separate.

Before the maintenance window, obtain a read-only snapshot:

```sh
nix run .#worker-resume -- --config /private/worker.json describe
```

Retain `snapshotDigest` and the returned identity/recipe fingerprints as private
evidence. After the separately authorized image transition, broker startup and
website unpause, prepare a fresh operation using that original digest:

```sh
nix run .#worker-resume -- --config /private/worker.json prepare \
  --operation UUID --deployment /private/instance/deployment.json \
  --snapshot-sha256 SHA256 --employee EMPLOYEE_UUID
nix run .#worker-resume -- --config /private/worker.json apply \
  --operation UUID --plan-sha256 SHA256
```

`--employee UUID` is repeatable and accepted only by `prepare`. An explicit
selection must contain one to sixteen distinct current employees who are
desired ON, not vacationing and not migrating. The host stores their sorted
IDs in the plan digest. Omitting the option retains the all-eligible behavior.
The snapshot still includes every employee: at apply's initial snapshot check,
a changed unselected identity, recipe, saved conversation or owner intent also
invalidates the operation. The full canonical cohort remains checked during apply.
Already-live selected employees use the normal already-live path; the tool does
not restart them. Saved Hands sessions use the ordinary cold-start producer,
with their existing session ID and settings, rather than attach-only recovery.

Every prepared plan expires at most 300 seconds after it is created. Waiting
between prepare and apply and final verification spend that budget. Selected
seats start serially, with at most 120 seconds
per wake inside that same deadline. That per-seat deadline is fixed before the
single wake call: its ACK and subsequent read-only native readiness checks share
the same budget. The caller's longer transport timeout does not extend either limit.
An ACK can precede native creation; the broker waits only for an absent or known
stopped laptop, releasing admission between probes. A running laptop with the
wrong binding, image, policy, limits or storage refuses immediately. The wait
never repeats the wake, sends input or changes a laptop. Native checks do not
claim model readiness. For slow cold starts, use one-seat operations: obtain
a fresh `describe`, review its complete snapshot against the retained bindings,
prepare a fresh UUID for one employee, apply once, and confirm completion and
current native health before preparing the next employee. Selection does not
make a failed or uncertain operation resumable.

The website must be unpaused and registered before describe/prepare/apply.
Let existing automatic recovery settle first: the normal producer's shared
in-flight wake can refuse another recovery. Native health alone does not prove
that this flight has completed. Do not change stop or vacation choices to
avoid that refusal.

Plans prepared by an older broker without the employee selection field cannot
be applied by this version; obtain a new snapshot and prepare a new operation.

Prepare and apply take the deployment's existing maintenance lock internally;
do not wrap the caller in another independently opened flock. Apply consumes one
durable attempt and uses serialized normal `CompanyWake.wakeOne` calls. The
existing per-employee lifecycle, resource admission and storage guards remain in
force. Stopped, vacationing, migrated or changed bindings cannot be overridden.
No tool stops or starts the website, broker or container engine, changes owner
choices, switches an image, or invents a provider recipe.

ACK loss and partial completion retain uncertainty. Inspect without replaying:

```sh
nix run .#worker-resume -- --config /private/worker.json status --operation UUID
```

The purpose-local journal does not allocate RAM or clear any resource reservation.
An attempted operation without its final durable completion record blocks a new
batch even if a final ACTIVE unlink was already visible. There is no automatic
reconciliation, reset or resubmission command.

This source needs a matching built website and broker sidecar before native
registration can be qualified. Controlled tests do not establish installed image,
ELF, website, provider, account or conversation continuity. Those remain separate
operator acceptance checks.
