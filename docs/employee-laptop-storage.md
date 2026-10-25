# Employee-owned laptop data

An employee's private data belongs to its permanent canonical company ID:
`stateRoot/employees/<employeeUUID>/{home,nix}`. The stable inside paths are
`/home/agent` and `/nix`. Session IDs select transport/runtime records at
`stateRoot/<sessionId>`; changing provider, model or conversation does not change
the employee data. Ad-hoc sessions retain a separate SID namespace and never
receive a synthetic employee identity. Human names and host labels grant no API
or filesystem authority.

The broker resolves exact current company bindings and retains host-private SID
lineage after plan-history pruning. Historical/retired/failed SID storage remains
resolvable for preservation, but cannot authorize a new employee process. A
private per-employee FD lease covers the entire laptop lifetime, including viewer
disconnects. Recovery reacquires leases and checks all running container writer
mounts before opening phones. Two sessions, duplicate labels or broader binds
cannot share a writable home/store. Owner intent and vacation remain independent
execution gates; migration never changes them.

New employees may initialize fresh data. Existing SID homes/stores require the
paired offline workflow; they are never hidden behind empty replacement data.
Source updates do not activate themselves. Ordinary owner source/host service
activation, current checkpoint and independent review precede live use. Never
replace personal NixOS configuration or use a container engine as host sudo.

## Paired offline publication

The optional host-only `employeeLaptopMigrate` package provides
`reverie-employee-laptop-migrate`. It has no stop, wake, model, provider, account or
grant verb. It requires an already stopped exact current employee laptop and
pins employee/owner/SID, intent/vacation, saved native conversation/account/model
references, runtime recipe, full broker config, original container/image,
resource/device policy, mount grants, profile links, data inode/bytes/modes and
SQLite registrations. Private reports exclude credentials, raw environment and
transcript contents. Runtime continuation is explicitly deferred.

Both source components must already be private durable SID directories on the
same filesystem as the employee destination. Use the reviewed Nix-only tool for
legacy scratch Nix preservation first. If the stopped original container still
binds legacy `/nix`, provide its matching private published Nix preservation
receipt; the paired tool validates that exact durable tree/database. It never
guesses which of two Nix copies is latest.

The following are operator templates, not authorization. Choose a private
canonical owner0700 receipt directory, exact current SID and fresh team/owner
checkpoint. The current employee-aware broker and its leases/fences must already
be independently verified; `--broker-ready` is an operator assertion, not a
version detector. Exclude direct host writers too.

```bash
nix run .#employee-laptop-migrate -- inventory
nix run .#employee-laptop-migrate -- plan --session "$sid" --nix-receipt "$nix_receipt" --receipt "$receipt"
nix run .#employee-laptop-migrate -- --apply plan --session "$sid" --nix-receipt "$nix_receipt" --receipt "$receipt"
nix run .#employee-laptop-migrate -- --apply --broker-ready --checkpoint "$checkpoint" stage --receipt "$receipt"
nix run .#employee-laptop-migrate -- --apply --broker-ready --checkpoint "$checkpoint" publish --receipt "$receipt"
nix run .#employee-laptop-migrate -- --apply --broker-ready --checkpoint "$checkpoint" verify-data --receipt "$receipt"
```

Omit `--nix-receipt` only when the original stopped laptop already binds that exact
durable SID store. Stage takes employee and SID startup locks, installs both
fences and journals each component before an atomic same-filesystem rename.
This preserves inodes and avoids another full copy. It verifies complete trees,
profiles, SQLite integrity and every registered path, then flushes the filesystem.
No running container may write any source, stage or destination ancestry.

Interrupted stage/publish may be explicitly resumed with the same inspected
receipt. Exact pinned inode/path/hash matches are mandatory; conflicts retain all
data and fences, never overwrite or delete to force progress. Before publication,
`abort` can move verified components back to their original fixed paths. Partial
abort is journaled too. It never wakes a laptop. After publication the employee
root is authoritative: abort refuses any return to stale SID copies. Recovery
and future plan changes must use latest canonical data, never an old snapshot.

Publication writes the private SID lineage, keeps a fixed legacy-source barrier
that old brokers refuse, and removes the employee migration fence only after the
paired receipt is durable. New brokers understand that exact barrier; arbitrary
legacy selectors cannot redirect employees to stale stores.

`verify-data` proves offline data publication only. It must precede intentional
image/resource changes or runtime writes; later qualification is a separate
reviewed acceptance. Preserve OFF/vacation exactly. Use only separately authorized
maintenance diagnostics for Nix/SSH/Docker while OFF; never start a provider just
to obtain evidence. Normal owner return must separately prove the same intended
native conversation/account/model and scoped API. A data receipt is never that
proof or a mission GO.

Do not wipe scratch after converting only current employees. Preserve historical
stores, unfinished source/results, retained analysis and external SSH/key/config
dependencies independently. An unreadable root-owned directory is UNKNOWN, not
empty or wipe-safe. Originals/retained stages are evidence; this tool never prunes.
