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
  --snapshot-sha256 SHA256
nix run .#worker-resume -- --config /private/worker.json apply \
  --operation UUID --plan-sha256 SHA256
```

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
