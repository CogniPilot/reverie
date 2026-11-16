# Registered console deployments

This crate is the reusable local owner bootstrap application API and its thin
Clap/JSON client. It reads the existing private `deployment.json`, uses the
existing deployment lock and retains durable attempts under `runtime/update-state`.
It does not execute request-supplied programs, change the broker generation, or
wake all employees. A future authenticated HTTP/GUI adapter must use this same
application service and its scoped authority, rather than duplicate the workflow.

The default adapter supports an ordinary Docker console, default bridge
networking and existing bind mounts. Other network and volume layouts refuse
before the live stop. Preview explicitly refreshes image defaults while
preserving old entries that differ from the old image defaults; it does not
infer whether an equal-to-default value was explicitly selected historically.
Private environment values remain in the owner-only operation record.

The existing GPU image has one fixed entrypoint ABI: `tini -g -s --`, the
immutable `reverie-container-runtime` executable, then
`/usr/local/bin/reverie-start`. Updating that profile may refresh the runtime's
Nix store hash from the exact owner-selected image. The source entrypoint must
match its original image, both runtime package versions must agree, and every
other argument and the command must remain unchanged. This does not admit an
arbitrary entrypoint, change the GPU device grant or qualify a new image.

`preview --preserve-network-grants` selects the checked original dynamic bridge
networks and aliases. The operation records exact native network IDs and
configuration, reobserves them before effects and verifies the candidate's
complete network set. Static addressing, custom driver options and non-bridge
drivers remain unsupported. CREATE sends original `NetworkID` values rather
than selecting a newly reused name; allocated endpoint IDs, addresses and DNS
names are not replayed. This is an immutable version-four operation: older
clients refuse it. The default preview and its network refusal are unchanged,
and this selection does not permit live account writers or waive verified backup.

The exact-ID lookup follows Moby's
[`getNetworkID` in docker-v29.6.1](https://github.com/moby/moby/blob/docker-v29.6.1/daemon/container_operations.go#L1083).
Built-in `bridge` remains name-selected by Docker, so independent native ID and
configuration revalidation remains required for it as well.

`preview --image sha256:IMAGE_ID --profile protected-website` explicitly selects
the fixed website security profile through the same application service. It
retains the original numeric non-root user, command, real bind grants and
unrelated host configuration; image defaults and differing environment overrides
follow the ordinary preview policy. The candidate uses a read-only root, drops
all capabilities, adds none, enables no-new-privileges while retaining existing
security options, and uses private PID/IPC
namespaces. Its only additional ephemeral mounts are `/tmp` (256 MiB,
mode 1777, nosuid/nodev) and `/run` (16 MiB, mode 0755, nosuid/nodev/noexec,
owned by the selected UID/GID). Existing binds at `/`, `/tmp` or `/run` refuse
rather than being hidden. Other binds, including all their write and propagation
grants, remain pinned and are compared before and after activation.

This selection is recorded in an immutable version-two operation; older clients
refuse that version. Ordinary previews keep the version-one representation.
Future protected updates require the explicit protected selection and must
observe the same two-entry tmpfs configuration and complete security settings. No
arbitrary tmpfs or generic validation exception is accepted. Shared-writer
refusal and verified snapshot/rehearsal requirements remain unchanged. Website
facts nomination and resource-owner approval are separate operations; a protected
candidate alone establishes neither.

The request uses Docker's legacy `HostConfig.Tmpfs` option map. On
[Moby 29.6.1](https://github.com/moby/moby/blob/docker-v29.6.1/daemon/container/container_unix.go#L381-L422),
the inspect mount-point list and legacy tmpfs map are separate representations.
The exact two-entry option map is always required; top-level `Mounts` may contain
no tmpfs rows or the complete two fixed corroborating rows. Partial, extra or
changed rows refuse. See Docker's [tmpfs option forms](https://docs.docker.com/engine/storage/tmpfs/).

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

`preview --image sha256:IMAGE_ID --preserve-network-grants
--live-account-writers-fix-forward` explicitly selects a different disposition.
Its version-five private plan lists the exact active writer container IDs,
immutable images, process incarnations and mounts. Only canonical direct
`console/accounts/PROFILE` directory binds qualify; console roots, ancestors,
metadata, aliases and other overlapping writers refuse. Prepare, website STOP,
candidate START and readiness publication recheck that inventory. Employees
receive no stop, start, pause, input, mount or network changes.
Every observed other active host-writable bind or volume is first matched to
its actual mounted inode through an anchored process-root descriptor and a
directory walk that refuses symlinks. A changed source pathname cannot make a
retained console bind appear disjoint. Unprovable bindings refuse. This finite
Docker observation also maps held FD mount IDs through the existing kernel
mount-table parser to compare physical backing paths. Current aliases of the
console, its ancestors or metadata are not disjoint. Nested host mounts under a
writable directory refuse with `DEPLOYMENT_LIVE_ACCOUNT_HOST_MOUNT_UNSUPPORTED`.
This does not certify absence of independent host-process, open-descriptor or
hardlink writers, and never certifies a consistent backup.

Apply first retains an ordinary full console copy while the website and account
writers may be active. This copy is **unverified**; no consistent backup or
automatic data restore is promised. Its receipt and status report
`backupVerified: false`. The preview also reports that code rollback compatibility
is not guaranteed: even a version-one to version-two company publication can
make the retained old console unable to read current data. Both containers and
the live source data remain retained for inspection and fixing forward. Normal
preview/apply and the existing skip-backup path retain their writer refusal.
Older plan readers refuse version-five effects rather than silently dropping
this disposition. No successful local deployment is claimed by these source tests.
