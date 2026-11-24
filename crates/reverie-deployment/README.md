# Registered console deployments

This crate is the reusable local owner bootstrap application API and its thin
Clap/JSON client. It reads the existing private `deployment.json`, uses the
existing deployment lock and retains durable attempts under `runtime/update-state`.
It does not execute request-supplied programs, change the broker generation, or
wake all employees. A future authenticated HTTP/GUI adapter must use this same
application service and its scoped authority, rather than duplicate the workflow.

The default adapter supports an ordinary Docker console, default bridge
networking and existing bind mounts. Other network and volume layouts refuse
before the live stop. Preview carries forward the running office's private HTTPS
enablement, hostname and web port, including values inherited from its image.
For other environment settings, preview refreshes image defaults and preserves
values that differed from the previous defaults.
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

## What the office is stopped for

The verified backup needs the office stopped. The archive, its comparison with
the console and the restore rehearsal are one proof about one set of bytes, and
that proof holds only while nothing writes the console. Running the copy while
the office is up would need a frozen view of the data, such as a filesystem
snapshot or a reflink clone taken during a brief stop; the tool has neither.
The `--live-account-writers-fix-forward` plan copies without stopping and its
copy is unverified for that reason.

Preview therefore states the cost. Its `stopped_backup.estimate` gives the
console's entries and bytes, the space the archive and the rehearsal need, and
`bytes_written_while_stopped` and `bytes_read_while_stopped`. A verified update
writes the data twice and reads it back about nineteen times across the console,
the archive and the restored copy, which is why a 27 GB console took about
fourteen minutes. The figures are measured while the office runs; if the
console cannot be measured, `estimate_refusal` gives the code instead.

## Checks before the stop

Apply decides everything it can while the office is still running. After the
candidate, bind, network and shared-writer checks it refuses, without stopping
anything:

- a rehearsal root that is missing, not a directory, reached through a
  symbolic link, not owned by you with mode 0700, not empty, or a view of the
  console or operation storage (`DEPLOYMENT_REHEARSAL_ROOT_REFUSED`; the
  snapshot code says which, for example `SNAPSHOT_REHEARSAL_ROOT_MISSING`);
- a backup destination that already exists or whose parent others can write
  (`DEPLOYMENT_SNAPSHOT_REFUSED`);
- a console with more entries or deeper nesting than the capture accepts
  (`DEPLOYMENT_BACKUP_ESTIMATE_REFUSED`);
- too little free space (`DEPLOYMENT_BACKUP_SPACE_INSUFFICIENT`). `detail`
  lists each filesystem, the copies it will hold, and the bytes required and
  available. The requirement is the estimate plus one sixteenth plus 256 MiB.
  The archive and the rehearsal are added together when they share a
  filesystem. The size of a compressed archive is not known in advance and is
  not part of the requirement.

`reverie-deployment --root ROOT check-storage [--rehearsal-root DIR]
[--compress-backup]` runs the same storage checks at any time, including before
preview, and changes nothing.

The operation directory is
`runtime/update-state/console-deployments/<operation>/` under the installation.
Ordinary apply keeps the archive and extracted rehearsal there. To put the
extraction on a separate filesystem, pass `--rehearsal-root /absolute/private/directory`
to apply. Create it first, for example with `mkdir -m 700`. Any name is
accepted; it does not have to match the operation. Choose a directory outside
worker mounts.

Add `--compress-backup` to stage both the raw tar and its extraction on the
rehearsal disk. Budget for both copies there. The operation directory then
holds `snapshot/console.tar.gz`. Before the swap, the updater reads back the
complete gzip file and compares its decoded length and SHA-256 to the tar
that passed the restore rehearsal. The snapshot receipt records both checksums.
For an ordinary update, capture, restore verification, and compressed publication
each have up to 30 minutes. An explicit initial-operation deadline still limits
the entire update.
The retained-copy workflow still writes its copy under `retained-copy/`.

An image archive can be staged on scratch. Importing it still requires space
in Docker's image storage for new layers. When Docker and the operation directory
share a filesystem, leave room for the image import and the backup together.

## Mounts during the backup

The backup proves that its destination is not a view of the console, and that
proof is read from the kernel mount table. The table is read again around every
verification. A mount is compared when its mount point is, lies above, or lies
inside one of the paths the backup uses: the console data root, the directory
holding the archive, a separate rehearsal root, the compressed-backup
directory, `/proc`, and `/nix/store` where the installed tools and their
libraries live. For each such mount the identity, parent, device, root, mount
point and filesystem type must be unchanged, and none may appear or disappear.
A change refuses with `SNAPSHOT_MOUNTS_CHANGED`.

Mounts elsewhere are ignored. Another container starting or exiting, an image
build, or a removable disk no longer fails an update. Mount options are not
part of the comparison because the shared mount parser does not record them;
they were not compared before either.

## When apply fails

If apply fails after it has stopped the office, it starts the original console
again itself. This is the same checked rollback as the `rollback` command: one
journaled attempt, fresh inspection of both containers, the bind and network
checks, and a readiness check before the `restored` receipt. The output keeps
the original failure in `code` and `diagnostic` and adds `sourceRestore`:

- `RESTORED`: the original console is running and answered its readiness
  check. The operation is closed; begin a new preview after fixing the cause.
- `NOT_ATTEMPTED`: no restore request was issued and `sourceRestore.code`
  says why. The office may be stopped. `sourceRestore.command` is the rollback
  command to run once the cause is understood.
- `UNPROVEN`: the one rollback attempt was used and its result could not be
  confirmed. The office may be stopped. `sourceRestore.command` is the same
  rollback command; see below for what it does after an attempt.

The restore is issued only while the new console has provably never run, which
the Engine reports as the `created` state. Once it has started, it may have
written data the old console cannot read, so returning to the old code stays
the owner's decision (`DEPLOYMENT_AUTOMATIC_RESTORE_CANDIDATE_STARTED`). A lost
Engine response also stops the restore, because the container may still be
changing (`DEPLOYMENT_AUTOMATIC_RESTORE_OUTCOME_UNKNOWN`). In both cases the
output and `status` name the rollback command.

The decision is journaled as `automatic-restore` before any restore effect and
appears in `status` as `automatic_restore`, with the cause and the outcome.
This behaviour is part of apply and has no switch: a restore only starts the
original container, every journal, container and backup stays in place for
review, and it refuses by itself in the cases above.

After an automatic restore the operation is closed, so `activate-retained` no
longer accepts it. To fix forward with an unverified copy, prepare a fresh
operation and use `activate-retained --stop-running-source`. That command
restores the original console the same way if it fails after its own stop.

The bounded initial rollout (`rollout_initial_website` and
`update_uninstalled_website`) is unchanged. It settles its own failure under
one deadline and does not restore the console.

Rollback addresses only the original retained container identities. It retains
both containers, never bulk-wakes employees and never automatically restores data.
It checks the binds and networks before it journals its one attempt, so a
refusal that is already visible does not use the attempt up. An attempted effect
is not automatically retried after a lost response. After the attempt, running
`rollback OPERATION` again issues no request: when it observes the original
console running under its own name and ready, with the candidate stopped, it
records `restored`; otherwise it refuses with
`DEPLOYMENT_ROLLBACK_ALREADY_ATTEMPTED`. The registered active-operation fence
and private receipts stay available for review.

`status` adds `recovery` and `rollbackCommand` when an operation is left at
`STOP_UNCONFIRMED`, `SNAPSHOT_VERIFIED`, `SWAP_UNCONFIRMED`,
`START_UNCONFIRMED` or `ROLLBACK_UNCONFIRMED`, for example after the updater
process itself was killed.

## Removing old backups

Each verified update keeps a full archive in its operation directory and a
full extracted copy in the rehearsal location. `reverie-deployment --root ROOT
prune-deployments` reports what earlier operations still hold, and with
`--apply` removes it.

The command follows the journaled claim handovers back from the active
operation. It does not list directories or match names. For each operation it
considers only the `snapshot` and `retained-copy` directories inside that
operation, and the `rehearsal` and `snapshot` directories inside a separate
rehearsal root that the operation journaled before writing there. The
rehearsal root itself, anything else in it, the operation journals and both
containers are kept.

An operation's storage is removed only when the operation ended ready, restored
or refused and a later operation took over its claim. The active operation is
always kept. So are the `--keep` most recent operations that hold storage,
counting the active one (default 2), and any operation that did not close.
History stops at the first operation the installation cannot read, and nothing
older is considered. A rehearsal root that has been replaced, or that a newer
operation used again, is not attributed to the older operation.

Apply journals the rehearsal root from this version on. A rehearsal copy made
by an earlier version was not journaled and is not removed; delete it by hand
once the report shows the operation as closed.

Run `reverie-deployment --root ROOT status` to inspect the operation holding
the installation claim. This works after losing the operation ID. A preview
without a claim still needs its explicit ID. An installation with no claim
returns `DEPLOYMENT_NO_ACTIVE_OPERATION`.

Run `reverie-deployment --root ROOT status OPERATION` after a lost response.
The Rust client can read the registered journal while the Docker socket is
unavailable. An outstanding stop attempt, for example, still reports
`STOP_UNCONFIRMED`. If a terminal receipt exists but live verification fails,
`stage` is `READINESS_UNCONFIRMED`, `readiness_failure.recorded_stage` gives
the historical stage, and `readiness_failure.diagnostic.error.code` identifies
the failed check. Reading status never repeats an operation.

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

For a fresh prepared operation, add `--stop-running-source` to that command
to stop the running console before retaining the copy. The deployment tool
checks the original container incarnation, candidate, bind grants and shared
writers before recording and issuing the stop.

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
Every observed other active host-writable ordinary-data bind or volume is first
matched to its actual mounted inode through an anchored process-root descriptor
and a directory walk that refuses symlinks. A changed source pathname cannot make a
retained console bind appear disjoint. Unprovable bindings refuse. This finite
Docker observation also maps held FD mount IDs through the existing kernel
mount-table parser to compare physical backing paths. Current aliases of the
console, its ancestors or metadata are not disjoint. Nested host mounts under a
writable directory refuse with `DEPLOYMENT_LIVE_ACCOUNT_HOST_MOUNT_UNSUPPORTED`.
This does not certify absence of independent host-process, open-descriptor or
hardlink writers, and never certifies a consistent backup.

Root-owned helpers whose writable mounts are exclusively real cgroup2 directories
may instead earn a separate virtual-filesystem observation. Held source FDs must
actually belong to cgroup2 and have a different filesystem from the ordinary
console. The target's real kernel mount table must match each exact destination,
device and backing root, a visible mount-parent chain and no nested overlay. Process birth, the complete
Engine identity and the exact target mount table are rechecked around the reads.
Missing or contradictory evidence refuses. No process-root permission check is
waived for ordinary data, no cgroup is written, and a cgroup-looking pathname or
root user label cannot select this proof. The three host-cgroup tests run as an
explicit mandatory Rust CI step outside Nix build sandboxes; selection asserts
all three pass and never silently skips an unavailable prerequisite.

Apply first retains an ordinary full console copy while the website and account
writers may be active. This copy is **unverified**; no consistent backup or
automatic data restore is promised. Its receipt and status report
`backupVerified: false`. The preview also reports that code rollback compatibility
is not guaranteed: even a version-one to version-two company publication can
make the retained old console unable to read current data. Both containers and
the live source data remain retained for inspection and fixing forward. Normal
preview/apply and the ordinary rollout skip-backup path retain their writer refusal.

For an already prepared live-account plan, the owner can run
`reverie-deployment --root ROOT apply OPERATION --skip-backup` to omit the live
copy. The same writer, mount and container checks apply, and the previous
console container and live data are retained. The activation receipt records
`backupCreated: false` and `backupVerified: false`. This flag requires a
live-account plan.

Older plan readers refuse version-five effects rather than silently dropping
this disposition.
