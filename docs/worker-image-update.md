# Worker image switch core

`lib.workerDockerImageProvenance` builds immutable facts for the exact same
arguments as `lib.workerDockerImage`: `system`, `uid`, `gid`, subordinate UID/GID
starts and count, and optional `browser` (default `false`). It selects that
factory's archive and static human toolkit itself; there is no caller-supplied
archive, toolkit, command or qualification flag. The output is
`share/reverie/worker-image.json`, purpose `worker-image-provenance-v1`.

Save the selected factory arguments in an owner-private JSON file outside the
checkout, with only `system`, `uid`, `gid`, `subuidStart`, `subgidStart`,
`subidCount` and optional `browser`. Confirm the mapping ranges against the
existing protected host grants described in [worker-docker.md](worker-docker.md).
From the reviewed committed checkout, build the matching archive and facts with:

```sh
export REVERIE_WORKER_FLAKE="git+file://$(pwd -P)?rev=$(git rev-parse HEAD)"
export REVERIE_WORKER_PROFILE="$HOME/reverie/worker-image-profile.json"
nix build --impure --expr '
  let f = builtins.getFlake (builtins.getEnv "REVERIE_WORKER_FLAKE");
      selected = builtins.fromJSON (builtins.readFile (builtins.getEnv "REVERIE_WORKER_PROFILE"));
  in f.lib.workerDockerImageProvenance selected
' --out-link "$HOME/.local/state/reverie/worker-image-provenance"
```

The facts reference the archive's immutable store path. No host account setup,
image load, broker configuration write or laptop recreation occurs in this build.

The producer binds the complete image Config/RootFS/platform/creation metadata,
archive bytes, fixed factory/source inputs and exact static toolkit manifest. It
pins the selected producer/import/wiring files inside the full immutable source
path; those selected hashes alone do not attest the entire Nix toolchain closure.
Complete Config/RootFS and archive verification remain separate required facts. It
hashes the actual layer streams and verifies the final direct, root-owned mode
0555 toolkit files and protected ancestors, including later replacements and
whiteouts. It parses ELF metadata without running either program. The artifact
is neither owner authorization nor a running-container/canary receipt. A native
caller must independently compare the actual loaded image with these full facts,
qualify its current lifecycle/custody/capacity/owner conditions and preserve
uncertain outcomes. Building facts does not load, select or activate an image.

Keep the owner's actual UID/GID, subordinate mappings and rootless/browser
profile when selecting this factory. Generic `workerImage` uses UID/GID 2000 and
does not substitute for a differently qualified fleet. Browser tooling adds no
device grant. The static toolkit is included by `worker = true`; there is no
separate toolkit-enable argument. Real H/channel and rootless-Docker acceptance
remain separate canaries after an admitted installation window.

The reusable `reverie.worker_image.WorkerImageUpdate` stage changes only a private
broker configuration's top-level `image` value. It is intended for fixed host
maintenance compositions. The core itself grants no paired website activation
or fleet lifecycle authority.

The owner-local `prepare-worker-image-switch` / `apply-worker-image-switch`
composition is separate from paired website activation. It uses the existing
packaged `reverie-worker-service --config ...` launcher, an already READY R
domain, its exact installed matching broker generation, a fresh private
`--operation`, and a closed private `--selection`:
`oldImage`, `newImage`, `deploymentPath`, and `profile: {path, sha256}`. The
profile must come from the fixed immutable worker factory provenance producer;
copied instance JSON, image tags, a generic UID2000 image, or an evaluated path
without qualification cannot replace it. The deployment must match the current
worker's company root and website name; its existing
`runtime/update-state/update.lock` is derived, never chosen as a command option.
An unmatched update-state override refuses.
Upgrade the broker transport to that exact package generation first. A legacy
registered unit does not gain the new startup fence from the caller's code;
an older precheck/broker generation therefore refuses before image maintenance.
The manager's loaded precheck and broker paths and argument vectors must also
match the immutable unit, with no drop-ins or pending reload. The on-disk link
and `NeedDaemonReload=no` alone do not prove that systemd loaded the new code.

Prepare records a finite plan and releases its locks without changing the image
or leaving a hold. Apply requires `--plan-sha256`, obtains maintenance followed
by the existing R admission lock, repeats the native plan, then publishes a
closed durable purpose in the existing R pending file before calling this core.
Only that process's fixed transition object can recognize its own fence. The
reservation marker, resource/profile journals, owner intent and GPU grants stay
unchanged. Both lock finalizers complete while pending remains; current facts
and private identities are checked before the final pending unlink. A possible
write, ACK loss or finalizer failure retains reconciliation-required evidence;
there is no force, retry, clear or automatic rollback path.

Ordinary service start, its real unit precheck, and broker recovery refuse the
durable pending file. R admission also binds the current configuration's image
and rechecks its identity after native observation. A process which loaded an
old image before maintenance therefore cannot resume after fence removal and
create using the old pin. The tool never stops a broker or laptop to satisfy its
preconditions. An installed H/resource consumer requires its separate reviewed
maintenance/rebind workflow. Success means only `IMAGE_PIN_COMMITTED`;
fleet recreation and native toolkit qualification remain separate acceptance.

Both image arguments must be full, lowercase `sha256:` IDs that Docker already
has loaded. Tags, names, short IDs, URLs and omitted pins are refused. Moving a
tag cannot change selection. The stage never builds, pulls, loads, starts,
stops or restarts an image, service or laptop.

`plan(expect_old, new_image)` is read-only. It validates the actual ordinary owner,
canonical private configuration, existing policy through the shared `validate_config` body used by `load_config`, exact
old pin, loaded old/new IDs and one local Linux engine. The fixed broker unit must
be loaded and inactive with no main/control process or queued job. Deployment
laptops must be stopped and settled. A complete bounded container inventory also
checks that private configuration and backups are outside container mounts.
Pool policies remain supported; an image-only update does not run the separate
admission-only service-install preflight.

The plan returns exact configuration-byte, engine-endpoint and plan digests,
old/new image IDs and the checked inactivity facts. It contains no configuration
bytes, credentials or private path. An unchanged worker image should be skipped
by the paired planner rather than sent to this distinct-image writer.

`apply(expect_old, new_image, expect_config_sha256=..., expect_plan_digest=...)`
requires an explicit old image and configuration-byte compare-and-swap. The plan
digest is optional for callers that also bind engine selection. Apply takes its
own nonblocking exclusive `.worker-image.lock` in the private configuration
parent. This lock is not reentrant; the paired planner's common maintenance lock
must be a different lock acquired before calling the stage.

Before publication, apply rechecks configuration, manager, engine and deployment
inventory. It retains exact original bytes and a prepared receipt in a private
`.worker-image-<path-digest>` directory, then fsyncs an image-only candidate and
atomically replaces the configuration. Every byte outside the top-level JSON
image value token is preserved, including whitespace, Unicode and nested values.
Owner/group/mode, current byte digest and parsed policy are checked on readback.
The stage checks inactivity again and durably records a committed receipt before
returning success. Backup and receipt files remain private and are never evicted
automatically; bounded storage exhaustion refuses another update.

`ImageRefused.code` reports a fixed precondition failure. A possible publication,
failed readback, changed runtime or uncertain durable receipt raises
`ImageUpdateUnconfirmed` with a bounded result and retained backup. It never
retries publication or restores old bytes automatically. The paired planner must
hold its own durable recovery fence and must not proceed to website cutover on
that result.

Worker rollback uses the same `plan` and `apply` methods with image IDs reversed
and a fresh byte digest. It changes no company intent, credentials, storage,
resource policy or provider field and does not activate the old image. Schema
compatibility and verified prune-OFF requirements for an image without lease
protection remain separate admission checks before any later activation.

A prepared transaction without a terminal receipt, or any unconfirmed transaction,
blocks subsequent plans and writes with `previous-update-unconfirmed`. There is no
force, clear-journal or repair option. Recovery requires separate reviewed evidence;
a reversed-pin call cannot bypass that fence. A failure before publication may be
retried only when the journal durably identifies that transaction as failed.

Custody checks cover configured future worker grants and actual mounts from all
containers, including website and foreign containers. They include canonical and
symlink aliases, host-visible inode aliases and existing nested host mountpoints.
The configuration, persistent lock and complete backup/receipt subtree must remain
outside those grants. Read-only mounts are exposure too. Inaccessible actual mount
sources, malformed inventory and unavailable or changing mount tables refuse the
operation. Bind-identity negative test fixtures simulate manager metadata; they do
not qualify a real daemon or a privileged mount setup. The selected Unix Docker
endpoint, matching host kernel and host-visible source paths must describe the
owner's trusted host engine; this core grants no authority to an untrusted engine
or forwarded socket. The paired integration must preserve that trust binding.

The internal lock serializes this writer. It does not stop unrelated owner commands
from starting services or changing mounts. The paired caller must hold its distinct
maintenance guard throughout both stages. Runtime drift found after publication is
unconfirmed, with no automatic restore or website cutover.

The image writer validates captured bounded bytes through the same policy function
as the ordinary loader. It never reopens the config with an unbounded text read;
replacement by a FIFO between policy validation and identity recheck refuses.

Apply fsyncs the private audit directory's parent before publication, including
when reusing an existing marked audit directory. Fsynced backup files must remain
reachable after a crash; file and child-directory fsync alone are insufficient.

Historical terminal filenames are never sufficient proof of completion. Prepared
and terminal receipts must have the exact closed schema, transaction, unit,
engine and old/new pins; terminal bindings must match the prepared receipt. The
exact backup must match its before digest and yield the declared after digest
through the image-only transformation. Partial, malformed, missing or contradictory
receipt data holds the journal without rewriting it.
