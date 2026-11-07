# Registered console deployments

This crate is the reusable local owner bootstrap application API and its thin
Clap/JSON client. It reads the existing private `deployment.json`, uses the
existing deployment lock and retains durable attempts under `runtime/update-state`.
It does not execute request-supplied programs, change the broker generation, or
wake all employees. A future authenticated HTTP/GUI adapter must use this same
application service and its scoped authority, rather than duplicate the workflow.

The closed initial adapter supports an ordinary Docker console, default bridge
networking and existing bind mounts. Other network/protected/volume layouts
refuse before the live stop. Preview explicitly refreshes image defaults while
preserving old entries that differ from the old image defaults; it does not
infer whether an equal-to-default value was explicitly selected historically.
Private environment values remain in the owner-only operation record.

Preview pins the old container/configuration and candidate image. Prepare creates
and inspects a sleeping candidate. Apply observes the exact source stopped,
captures and verifies its console data, rehearses extraction, rechecks the
source, and only then swaps names and starts. Readiness requires the HTTP status
and an actual Rust-front/Node process relationship. This remains hybrid readiness;
the one-employee message, laptop, perf and restart trial is separate acceptance.

Rollback addresses only the original retained container identities. It retains
both containers, never bulk-wakes employees and never automatically restores data.
An attempted effect is not automatically retried after a lost response. The
registered active-operation fence and private receipts stay available for review.

`confirm OPERATION` explicitly reinspects the recorded sleeping candidate after
a refused validation. It does not repeat container creation. `activate-retained
OPERATION --accept-unverified-backup` is an explicit owner fix-forward recovery
while the original console is stopped and the checked candidate has never run.
It retains an ordinary archive-mode copy using the installer-selected copy
program, preserves all existing mounts and both containers, and uses the same
checked swap. The copy is not a consistent snapshot: status and the readiness
receipt report `backup_verified: false` / `backupVerified: false`. No recovery
path automatically extracts data onto the live company. Returning to an older
console can fail after newer schema writes; this mode accepts fixing forward.

The snapshot is a verified copy of the observed stopped console subtree. Other
worker-writable account paths require an explicit writer/consistency disposition;
the shared deployment lock alone does not establish whole-company quiescence.
This source is under qualification and is not an installed deployment claim.
