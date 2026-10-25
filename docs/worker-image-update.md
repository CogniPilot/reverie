# Worker image switch core

The reusable `reverie.worker_image.WorkerImageUpdate` stage changes only a private
broker configuration's top-level `image` value. It is intended for the reviewed
paired-image planner. It currently has no worker-service CLI or flake wiring;
that wiring remains subject to the paired contract review.

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
