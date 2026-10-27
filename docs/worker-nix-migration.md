# Durable private laptop Nix stores

New laptops keep their independent writable `/nix/store` and `/nix/var/nix`
database at `stateRoot/<sessionId>/nix`. Their existing home and profile links
stay at `stateRoot/<sessionId>/home`. Compiler caches, build outputs, downloads,
leased tasks and temporary files retain the existing `/scratch` mount. This is
not a shared store and never mounts the host Nix daemon, store or database.

`stateRoot` must be a canonical, private, durable owner-selected directory,
outside scratch and every shared project/workspace mount. Select a filesystem
that survives the owner's reboot and cleanup policies; a directory named
scratch is not evidence that reboot erases it. Automatic global scratch pruning
is currently deferred. No broker configuration schema or resource grant changes
are needed. The broker service retains its 512-task/512-MiB limits.

Existing running laptops retain their mounts and terminal programs until an
explicit checkpoint and replacement. If a legacy `scratchRoot/<sessionId>/nix`
exists without a durable store, creation fails closed instead of hiding the
installed setup behind a newly seeded store. A migration fence blocks creation;
a per-session flock covers the complete preparation/startup window so an
in-flight helper or container creation cannot race a migration.

## Source activation is a separate maintenance gate

Build the exact reviewed `workerBroker`, `workerService` and `workerNixMigrate`
outputs with Nix. Retain their store paths, review commit and private config hash.
Do not regenerate the live broker configuration with `isolate prepare`, replace
resource overrides, change selected accounts, or combine this with a console
release. These binaries do not activate themselves.

There is no broker source hot reload. `reload-resources` changes resource policy
only. The deployed broker must be upgraded before the executor's fence/lock
protocol can protect live creation. Installing a new executable or systemd unit
without restarting leaves the old process in control. `--broker-ready` is an
operator assertion of an actually completed, independently verified activation;
it is not permission or a source-version detector.

**Broker restart is a fleet transport interruption and remains a prerequisite,
not a tested zero-interruption promise.** The client returns failure on socket
EOF. Broker shutdown disconnects terminal viewers and scoped office proxies.
The provider's laptop tmux should remain separate, but prior operational failures
mean service/socket health alone is insufficient. Existing website startup
`reattachLaptops` uses verified running inventory and attach-only requests; it
is not a continuously guaranteed reconnect path after broker loss. Attach-only
must never create a missing laptop or rerun a provider command.

Before activation, save fresh handoffs and current provider conversation/resume
IDs for every running expert through its authorized normal workflow. A previous
"safe to move" message expires when new work starts. Rehearse broker EOF and
attach-only reattachment with synthetic data and the same CLI family. Record the
same container ID, host PID/start time of its provider, laptop tmux pane, selected
model/account/conversation and a scoped API response before and after. If a CLI
exits, prove its normal same-conversation resume before fleet maintenance; do
not invent flags or launch a fresh conversation as a substitute. The filesystem
migration harness below does not prove provider transport survival.

Only after this gate may the owner coordinate a broker source switch and normal
website attachment restoration. For an owner user service, ordinary owner
`systemctl --user` installation/activation suffices; keep all effective unit
settings unchanged. If the deployment instead uses the NixOS system service,
use normal owner-authenticated NixOS activation. Container sudo and engine access
are not host administrator authentication. Prove every running terminal/provider
and scoped API recovered before migrating the first store. If that cannot be
proved, stop here with the store migration unactivated and originals intact.

## Operator executor

The host-only `nix run .#worker-nix-migrate -- ...` executor defaults to read-only
inventory/dry-run. It prints no raw engine environment, launch request, prompt,
credentials or private home contents. Its receipts contain private identities,
mount paths, hashes and preservation evidence; keep them outside Git and shared
drives. A receipt's parent must already be canonical, owner-owned and mode 0700.
Use a durable private directory, for example:

```bash
install -d -m 700 "$HOME/reverie/runtime/nix-migrations"
nix run .#worker-nix-migrate -- inventory
```

Choose exactly one session from fresh inventory and verify its employee identity,
container ID, `/nix`, home and scratch bindings, current model/account/conversation,
intent/vacation state and free space on both filesystems. Record active peers.
The executor binds the plan to the entire broker configuration hash, exact source
container, employee ID/session/owner, saved runtime recipe, resource/device
policy, every mount, profile links and peer IDs/PIDs/states. Any change halts the
phase for coordinator review. It never starts, creates, removes or wakes laptops;
quiescence can stop only the planned exact container. No API write is performed.

Planning also refuses a selected laptop whose immutable image differs from the
broker's current image. Normal recreation would select the current broker image.
Review old/new image compatibility separately before proceeding; an approved
paired upgrade can use `plan --allow-image-upgrade`, which records both image IDs
and requires the current broker image at verification. This flag is not evidence
of compatibility. If the task must preserve the original image, defer that target
until an independently reviewed image-preserving recreation path exists. Never
temporarily change the global image while peers might launch.

For a running target, create a unique **non-base registered store sentinel**
before planning, root it in that target's Nix gcroots, and record its NAR hash.
Use the already authorized owner/operator channel. For example, inside only that
selected laptop:

```bash
printf 'unique reviewed migration sentinel\n' > /scratch/tmp/nix-migration-sentinel
sentinel=$(nix-store --add /scratch/tmp/nix-migration-sentinel)
ln -s "$sentinel" /nix/var/nix/gcroots/reverie-migration-sentinel
nix-store --query --hash "$sentinel"
```

Use a fresh gcroot name if one exists; do not overwrite another task's root.
An existing base-image package such as coreutils is insufficient proof. For a
stopped/vacation/retired target, preserve stopped intent and migrate its offline
data without waking it to make a sentinel. Defer runtime acceptance until a
separately authorized normal wake.

Set `session`, `receipt` and `sentinel` from this fresh, private review. The
following commands are an operator template; each mutation needs the applicable
current checkpoint and completed broker gate:

```bash
nix run .#worker-nix-migrate -- plan --session "$session" --receipt "$receipt" --sentinel "$sentinel"
nix run .#worker-nix-migrate -- --apply plan --session "$session" --receipt "$receipt" --sentinel "$sentinel"
nix run .#worker-nix-migrate -- --apply --broker-ready --checkpoint "$checkpoint" quiesce --receipt "$receipt"
nix run .#worker-nix-migrate -- stage --receipt "$receipt"
nix run .#worker-nix-migrate -- --apply --broker-ready stage --receipt "$receipt"
nix run .#worker-nix-migrate -- --apply --broker-ready publish --receipt "$receipt"
```

Quiescence installs an exclusive fence and stops exactly the recorded container,
leaving desired-running/vacation/retired state untouched. A copy is refused if
any running container has a writable bind exposing the source, destination or
stage, including a broader parent bind. The operator must also exclude direct
host writers; the broker lock protects broker creation, not arbitrary host Nix
commands. Neither a live SQLite database nor an actively used cache is copied.

Stage uses `cp --archive --reflink=auto` to a unique adjacent private directory,
preserving all bytes, symlinks, hardlinks, modes, uid and gid. It refuses foreign
ownership and special files, reserves 512 MiB beyond the logical byte count,
hashes the complete source and destination, checks SQLite integrity and all
registered paths, and flushes the copied filesystem. DB validation uses an
independent database-and-WAL copy on scratch; opening even a read-only live
SQLite database can alter shared memory. The original remains intact. Stage and
publication command deadlines are bounded; a timeout leaves its fence/evidence
for review rather than deleting partial data or retrying blindly.

Publication rechecks source/stage hashes and writers, atomically renames the
stage into place, retains any prior destination at its unique receipt path,
flushes the filesystem, saves the receipt, then removes the fence. A running
laptop must now be **normally recreated through its existing saved employee
runtime recipe** by the owner or currently authorized scoped recovery workflow.
The executor deliberately does not call a wake API or reconstruct a provider
command. Verify the selected employee is still explicitly desired-running and
not on vacation, retired or rebound. Never wake an originally stopped target as
part of this migration. Keep the same model, account, conversation, home,
scratch, project and device mounts.

After normal recreation of a previously running target:

```bash
nix run .#worker-nix-migrate -- --apply --broker-ready verify --receipt "$receipt"
```

Verification requires a fresh container ID, matching immutable image/resources,
all original grants with only `/nix` source changed, unchanged profile links,
the registered non-base sentinel's original hash, live provider tmux pane and a
200 response from its scoped office API. Independently inspect the expected
provider process and actual same-conversation/model/account continuation; a live
tmux pane alone cannot prove a particular CLI identity. Confirm profile commands
work and all existing registered paths remain available. The copied DB inventory
is preserved in the staged receipt, before image preparation can merge entries.
Prove an unchanged peer terminal/API still works, then seek the next fresh target
checkpoint. A fence or failed acceptance halts this serial migration.

## Abort, rollback and interruption recovery

Before publication, `abort --receipt ...` with `--apply --broker-ready` removes
only this operation's matching fence, retains the source and any stage, and sets
an owner-only fixed legacy selector when restoring a scratch-backed target.
Resume through the same normal recipe only if current intent permits it.

After publication, **do not switch to the stale scratch original**: the durable
store may contain later installations. Save a fresh checkpoint and create a new
private plan with `plan --direction legacy`, the same exact session and current
sentinel. Execute quiesce/stage/publish as above. This copies the latest durable
store back to a new scratch stage, retains the old scratch original, and installs
`stateRoot/<sessionId>/nix-rollback.json`. The marker has exactly version 1, that
session ID and `legacy: true`; it cannot grant an arbitrary host path. Both store
copies remain available. The reviewed broker can now recreate only that target
using the fixed legacy path, leaving peers' durable stores unchanged. Apply the
same normal wake and verification gates. A later forward migration can archive
this prior durable destination before publishing another verified copy.

Do not revert broker source globally during a partial migration: it would select
scratch for already migrated laptops. A source rollback requires coordinated
per-laptop reverse copies first, or an independently reviewed compatibility
broker. No automatic source rollback or data deletion is implemented.

An interrupted stage leaves source, partial stage and fence; inspect its receipt
and retain evidence. Abort is available before publication. If copying completed
but publication was interrupted between renames, rerun only `publish` with the
same receipt after inspecting the exact paths; it recognizes a matching staged
or published tree, validates a retained old destination and completes without
overwriting it. A crash after the published receipt but before fence removal
uses the same bounded retry. If any paths/hashes differ, halt for manual owner
review; never unlink a foreign fence or delete a retained store to force progress.
After the fence is already removed, a published receipt proceeds to normal
recreation/verification, not a second publication.

Original and retained stores are intentional rollback evidence. No pruning is
part of this executor. Use the leased task-workspace helper for disposable test
artifacts and save a handoff before any later authorized cleanup. Source,
unfinished work, private store roots and live caches are not disposable tasks.

## Validation and synthetic container rehearsal

Run the required Python and OpenCode-plugin suites in `nix develop`, with a short
canonical owned scratch `TMPDIR`. Focused migration tests exercise real filesystem
copies and SQLite databases, including a committed WAL left by abrupt exit,
profile links, hardlinks, permissions, source changes, locking, foreign writers,
exact identity/recipe checks, stopped intent, partial publication and rollback
that preserves packages added after forward migration.

After independent review, the bounded synthetic harness can be run on a scanned
immutable worker image; it mounts no private company/account data or host Nix
store. Container creation/start/stop in this command needs separate authorization
from a preparation-only assignment:

```bash
mkdir -p "$HOME/scratch/reverie/nix-tmp"
nix develop --command bash -c '
  export TMPDIR="$(realpath "$HOME/scratch")/reverie/nix-tmp"
  timeout 45m python3 scripts/check-worker-nix.py --image "$1"
' bash "$reviewed_worker_image"
```

It seeds a synthetic legacy store, installs a home profile, runs a local build
and development shell, registers a unique non-base sentinel, performs the actual
executor's offline forward copy, creates a fresh container with the durable
mount and checks profile/sentinel/registration preservation. It adds another
registered object, rehearses reverse migration and fresh mounting, proves both
objects survive rollback, and runs Nix garbage collection with retained profile
and sentinel roots. Its owned workspace retains logs and a handoff. This is
filesystem/mount/recreation evidence; it does not reboot the host, activate the
broker, or prove provider EOF behavior.
