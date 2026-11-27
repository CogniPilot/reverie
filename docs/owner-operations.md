# Owner operations

The canonical architecture and implementation gaps are in
[SPEC_0001](../spec/SPEC_0001_OWNER_OPERATIONS.md).

The [employee resource rollout API](owner-resource-rollout.md) documents the
shared GUI/API contract and its current host-installation blockers.

See the [specification index](../spec/README.md) for DRY, crate boundaries,
valid-by-construction contracts, review and workflow rules. The
[Rust overhaul inventory](rust-overhaul.md) tracks migration work.

Console deployment previews and the final pre-stop check refuse observed writable
mounts from other running containers that overlap the console data, including
parent paths and resolved symlink aliases. `DEPLOYMENT_SHARED_WRITABLE_MOUNT`
means the shared writers need coordinated lifecycle maintenance before a fresh
preview. The updater never stops those writers implicitly. This early check is
an observation, not a whole-host writer-exclusion guarantee; the existing byte,
metadata and restore-rehearsal checks remain required.

A console update must not leave the office stopped. The
[deployment guide](../crates/reverie-deployment/README.md) describes the
behaviour in full; in outline:

- Preview states how many bytes the stop will copy and read back. Apply checks
  the rehearsal directory, the backup destination and the free space for the
  archive and the restore rehearsal before it stops the office.
  `check-storage` runs the same checks at any time.
- During the backup, only mounts on, above or inside the directories the backup
  uses are compared. Unrelated containers starting or exiting do not fail it.
- If apply fails after the stop and before the new console has ever started,
  it starts the original console again and reports both the failure and the
  restore. It does not do this after a lost Engine response or once the new
  console has run; the output then names the one `rollback` command.
- `rollback` never repeats an effect. After its one attempt it only records
  the restore once the original console is observed running and ready.
- `prune-deployments` reports, and with `--apply` removes, the backups and
  rehearsal copies of closed, superseded operations. It keeps the active
  operation and the most recent two that hold storage.

These are local owner commands over the shared application service. The
standalone owner API does not yet expose them; a GUI or HTTP adapter must call
the same service functions and must not reimplement the checks.

An outside-product replacement can leave a terminal active claim pointing at two
containers that no longer exist. The local owner may explicitly select
`preview --adopt-stale-claim OLD_OPERATION --expected-current-container FULL_CID`
alongside the existing image/profile/network/writer selections. Format 6 records
the old immutable READY/candidate/plan and the selected current website. It does
not turn that old READY receipt into current readiness. Both old exact CIDs must
return authenticated complete Engine 404 responses; the current registered
website must pass fresh configuration, init-incarnation, bind custody, native
process-tree and status checks. The three declared data/home/workspace bind
grants must agree; this does not prove old inode or data continuity.

Preview only freezes the selection. Prepare repeats the observations after
archiving the active claim, before atomically handing it over under the original
installation lock. Old records remain intact. Any uncertain handover or receipt
failure holds the original attempt before candidate creation; inspect its status
and retained records rather than submitting another operation or editing claims.

This follows Docker's documented [bind-mount write semantics](https://docs.docker.com/engine/storage/bind-mounts/).
Docker's [container commit](https://docs.docker.com/reference/cli/docker/container/commit/)
pauses the selected container and excludes mounted-volume data, so an image
commit cannot provide this shared-data backup. Coordinated shared-writer
quiescence remains a product workflow requirement.

## Office recovery supervisor

Under the boxed laptop runtime the office checks every employee who should be
running (in the office, `desiredRunning`) every thirty seconds and takes the
next mechanical repair step itself. An employee who is stopped or out of the
office is never read or repaired; only the approved limits of a laptop that is
still running are kept in place for them (below). It runs no HTTP request of its own: each step
is the service call behind the owner route for that step, recorded in the admin
audit log as `office supervisor` with one console line `[supervisor] …`.

`GET /api/company` carries a `supervisor` object on each employee: `condition`,
`sentence`, `code`, `since`, `last` (what it did and how that ended), `next`
(what it will do and no earlier than when), `waitingFor`, `waitingUntil` (when
that wait ends by itself, where it is known), and `needsHuman` (what a person or
a managing agent has to do, with the route to call). The company card shows the
short form and keeps the sentence in its tooltip.

No path of the supervisor ends for good. `needsHuman` is set in three cases
only: the owner switched that kind of step off in the company settings; the
office has nothing approved, or nothing on record, to act with (below); or a
step belongs to another part of the office that still names a person. A wait says what it waits for,
and `waitingUntil` says when it ends where a clock decides that.

Steps, least destructive first, each bounded per round. A round ends after ten
healthy minutes, and it also ends six hours after its last attempt: the counts
are then cleared and the steps start again from the first one, for every path.
While a used-up round waits for that, `waitingFor` reads “the next round of
repair steps, which starts at …” and nobody is asked for anything.

| Step | When | Bound |
| --- | --- | --- |
| Continue the laptop (the recorded request again) | the operation offers `continue` or `retry` | 4, spaced 30 s to 5 min; once when only `continue` is offered and the request was refused with a code that only a fresh laptop settles |
| Put approved limits back in place (the shared pool first, then the laptop's own) | a running laptop's read offers `repair-pool` or `repair` | the same 4 |
| Give the owner's standing default limits | no laptop and no approved resource limits, with the standing defaults switched on | 2 |
| Start a fresh stopped source | no record, approved limits | 3 |
| Continue a held plan move (`continue-original`) | a Docker move is `recovery-required` | 3 |
| Wake (attach a provider that already runs) | the terminal is not connected, or the session is not in a laptop | 6; once when the terminal's input is also held for good and the wake was refused |
| Put the plan's sign-in back into the laptop | the agent shows the provider's sign-in screen | 3, spaced 1 to 5 min; once when the laptop then holds a usable sign-in, or has no sign-in folder of the plan |
| Abandon a held plan move, or close one from before the laptop runtime | continuing did not help or is not offered, and the same error lasted 15 min (30 min when the cause lies outside the move) | 2 |
| Rebuild the laptop, then start it | the operation cannot advance, an unused laptop was made for an earlier laptop image, a code the office does not recognize has stood for 30 minutes, the laptop has been starting for 15 minutes, the agent stays parked on a provider start-up screen ([below](#provider-start-up-screens)), or the laptop is gone while an earlier laptop operation is on record. At once when nothing runs in the laptop; otherwise between the agent's turns | 2, and 2 per day across rounds |

One step belongs to no employee: the pool that all laptops share. The
supervisor recovers it by itself after a host restart, before it rebuilds
anyone. See [after a host restart](#after-a-host-restart).

A laptop record can offer `continue` for a step it has not issued while the
request is refused before that step, for example a set-up that was made for a
laptop image the office no longer uses
(`DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED`). The supervisor sends such a
request once. When it is refused with a code that only a fresh laptop settles,
it does not send it again and goes on to the rebuild, three minutes after the
problem was first seen, and then starts the fresh laptop. With
`supervisorAutoRepair` off it sends the request once and then names that switch
and the rebuild calls.

An office terminal whose input is held for good was the first case in which
the supervisor rebuilds a laptop its agent still runs in. The hold records an input
that may have been sent and was never confirmed; neither a healthy laptop nor a
new terminal client clears it, so every wake is refused, chat cannot reach the
employee and the office can never type to that agent again. The supervisor
wakes once. When that is refused it goes on to the rebuild, three minutes after
the problem was first seen, but never in the middle of a turn: the office
terminal must show the agent idle and its pane must have been silent for two
minutes, and both are read again immediately before the rebuild is requested.
The running laptop is discarded only when it is the one recorded laptop of that
employee. While a turn is in progress, or while the office is not reading the
pane, it waits and asks nobody. An agent that ended its
turn with work left running (a monitor, a background shell) is given thirty
minutes from when the problem was first seen, and is then rebuilt with that
work still running. The
home directory is
kept and the fresh laptop is started as after any rebuild. With
`supervisorAutoRepair` off it wakes once and then names that switch and the
calls, including `confirmDiscardRunning`. A terminal that is not connected but
still takes input is only woken, never rebuilt.

The same rule serves every other laptop that only a rebuild settles while an
agent runs in it, for example one whose limits helper failed for good or one
that reports `DOCKER_CONTINUATION_FOREIGN_PROVIDER` (something the office did
not start runs in its terminal, which the office cannot take over). Such a
laptop is rebuilt between the agent's turns and never in the middle of one:

- A turn the office terminal shows in progress is waited for, however long it
  lasts.
- An idle pane must have been silent for two minutes. The step reads the pane
  again itself immediately before the rebuild, and where the reason is a held
  laptop it reads the laptop again too; a laptop that has finished meanwhile is
  kept.
- A read that cannot say what runs in the laptop is never taken for an empty
  laptop. It is asked again for fifteen minutes; after that the laptop is
  treated as one an agent runs in.
- A pane the office cannot read at all has no turn to wait for. That is the
  case after an office restart for a session whose input is held (the office
  has no terminal on it), and for a process the office did not start. A read
  inside the laptop is made first, and a laptop it shows to be empty is rebuilt
  at once. Otherwise the laptop is rebuilt two hours after the problem was
  first seen, and `waitingFor` names that time. Two hours is four times what an
  ordinary turn is given; what an unusually long turn can lose is its
  unfinished step, because the home directory and the conversation saved in it
  are kept and the fresh laptop continues that conversation.
- Only the one recorded laptop of the employee is ever discarded this way. A
  second running laptop, or a running laptop that is not the recorded one, is
  refused.

A laptop code the office does not recognize is not acted on at once: it may be
a state of a newer laptop runtime that settles by itself. The recorded request
is sent again when the laptop offers that. When the code still stands after
thirty minutes the laptop is treated as held, under every rule above. A laptop
that has been starting, or between two states, for fifteen minutes without
becoming healthy is treated the same way from that moment.

The limit of two rebuilds per laptop per day is a pause. `waitingFor` reads “the
daily limit on rebuilds of one laptop (2) … the next one may run at …”, and the
next day the ladder goes on by itself. The rebuild of a laptop that was stopped
from outside together with its storage holder, as after a host restart, is
neither held back by this limit nor counted against it
([after a host restart](#after-a-host-restart)).

Every wait above that ends in a laptop being rebuilt (fifteen minutes of
starting or of an unreadable laptop, thirty minutes of an unrecognized code or
of work left running, two hours without a reading of the pane) counts only an
unbroken run of that same state as this office process saw it. A start that
follows a plan move, a start-up screen or the wait for the office's own restart
begins its own fifteen minutes, and a state that cleared and came back is
counted from its return. An office start begins all of these again at the
first look: the office watched nothing while it was down, and every employee
reads as starting for a minute while their terminal is attached again. What
paces the steps (when a problem was first seen, the attempts, the day's
rebuilds) is kept across an office start.

It never types into a sign-in screen (what it does about one is described
[below](#provider-start-up-screens)), never chooses limits
or a laptop layout of its own, never returns anyone to the office, and never
rebuilds a laptop in the middle of its agent's turn. A rebuild
reuses, verbatim, the layout of the employee's most recent laptop operation; an
employee with none on record is given the standing default (below). A stopped or missing
laptop is rebuilt while another laptop of the box runs. When none does, that is
what a host restart looks like: the supervisor recovers the shared pool first,
by itself, and the rebuild waits for that
([after a host restart](#after-a-host-restart)). A plan move is never left alone, whatever its error says: see
[a plan move that stopped part-way](#a-plan-move-that-stopped-part-way).

### Standing defaults for limits and layout

Two things about a laptop are approved by the owner for each employee: its
resource limits (`PUT …/docker-policy`) and its layout (the `template` of a
rebuild or reprovision request). An employee who had neither used to wait for
the owner. The company setting `supervisorStandingDefaults` (absent means on)
lets the office give such an employee what the owner already approved for the
other employees of the same company, reduced so that nobody is given more than
every one of them has:

- Limits: all of them must be in the same shared pool with the same pool
  limits. The employee's own limits are the smallest of each value (hard and
  soft memory, swap, tasks, CPU weight) and the processors all of them may use.
  They are saved through the store method behind the docker-policy route; the
  setting and the derived values are read again inside that save.
- Layout: all laptops that have a layout on record must run as the same user
  and keep scratch space under the same root. The drives are the ones every one
  of them has, read-only where any has it read-only. The choice among several
  office networks and a sign-in folder outside the home belong to one employee
  and are never copied. The layout is used for a rebuild and is recorded with
  that rebuild, as an owner's layout is.

The office makes up no number and no path. Where the others disagree on the
pool, the user or the scratch root, or no other employee has anything
approved, there is no default: `needsHuman` says so and names the call. With
the setting switched off, `needsHuman` names the setting. Each use is in the
audit log (`supervisor_apply_standing_limits`, or the rebuild's own entry).

One state is left that the office cannot leave by itself: an employee who has
never had a laptop in this office. Every laptop operation makes a laptop from
the record of an earlier one, which fixes where the home directory is, and the
employee's own office network is made by the host set-up. The supervisor says
so, goes on reading, and starts a stopped laptop of that employee as soon as
one exists.

### The office restarting itself

The laptop runtime is composed once, at start, from the fixed runtime
configuration and the private instance key, which the office keeps open and
compares on every use. Once either differs from what was read at start, every
laptop route answers `DOCKER_CONTINUATION_RUNTIME_CHANGED`, the supervisor
stops its passes, and nothing reads them again in place. A new office process
does. The office therefore ends its own process, by its ordinary graceful
shutdown, so that Docker starts it again; laptops keep running and are
attached again as after any office restart. It does so only when all of this
holds:

- the change has stood, with nothing about it changing, for ten minutes;
- a new process would accept the configuration that is in place and would read
  the same instance key (with another key every laptop's credential would be
  out of use, so the office never restarts itself into one);
- the Engine reports the restart policy `always` or `unless-stopped` for the
  office's own container. A container nothing would start again is never
  taken down;
- `supervisorAutoRepair` is not switched off;
- it has not restarted itself within the last hour, nor twice within a day.
  The record is `office-self-restart.json` in the office data directory,
  written before the exit and read after it; a record that cannot be read
  counts as a restart made at that moment.

Meanwhile every employee's `waitingFor` says what the office waits for, with
the time of the restart or the condition that keeps it from restarting. The
restart is in the audit log as `supervisor_restart_office`. The office cannot
see the host's update tool. An update stops the office container before it
changes anything, and Docker does not restart a container it was told to stop,
so a restart of this kind cannot run into one.

Putting limits back is not changing them. A reload of the host's service
manager resets the limits that only a helper wrote, and every laptop is then
refused although its agent is still running. The supervisor calls the same two
repairs an owner would ([below](#put-approved-limits-back-after-a-reload-of-the-host-service-manager)),
which write the already approved values again. It never rebuilds a laptop for a
hold of the shared pool: a new laptop would join the same pool. When its four
attempts for such a hold are used up it does not stop: the limits check below
takes that employee over and asks for the pool's limits again about every ten
minutes, for as long as the hold lasts. `needsHuman` says so and names the
same calls.

That reload resets the limits of every running laptop, whoever it belongs to.
So beside the repair steps the supervisor checks the approved limits of each
finished laptop about every ten minutes, one employee per pass, and puts them
back when they are gone. It does this for an employee who is running normally
and for one who is stopped or out of the office while their laptop still runs:
the two states in which no repair step looks at the laptop. The check needs
`supervisorEnabled` only. It writes only values the owner already approved,
attaches no terminal, reads and starts no agent, changes no attendance and
spends no attempt of a repair step. `GET /api/company` shows the last check as
`supervisor.limits` (`at`, `outcome`, and `detail`: `unchanged`, `restored`,
`not-running`, or the code of a refusal). A line `[supervisor] … keep-limits`
and an audit entry `supervisor_keep_limits` are written when limits were put
back, and once when a check starts to be refused.

Four company settings switch it (`PUT /api/company/settings`, owner only):
`supervisorEnabled` (observe, continue, wake, put a sign-in back, record the
pool's observation), `supervisorAutoRepair` (abandon, rebuild, give standing
limits, restart the office, recover the stopped pool) and
`supervisorStandingDefaults` (limits and layout for an employee who has none)
are on when absent. `acceptStorageRenumbering` is off when absent: it is the
owner's standing answer to a storage device change and is described
[below](#the-stored-home-of-a-stopped-laptop). Its pacing state is
`employee-supervisor.json` in the office data directory; deleting it only
restarts the waits. The waits of the pool step are kept in memory, so an office
restart starts them over, like the clocks above; every recovery it issues is in
the pool's own journal.

### After a host restart

A host restart stops every laptop, every storage holder and the anchor of the
pool that all laptops share. Docker starts the office container again by itself
when it was created with the `unless-stopped` restart policy (the installer and
`reverie-start` do that, and a console update keeps the policy of the console
it replaces) and the Docker service is enabled at boot. From there the office
brings everyone back without the owner:

1. The laptop runtime finds every laptop stopped. Each finished laptop reads
   `DOCKER_CONTINUATION_STORAGE_UNCONFIRMED`, because its storage holder is not
   running, and nothing starts a holder again: a fresh laptop gets a new one.
   The supervisor classifies that, and a stopped laptop, as a laptop to rebuild.
2. No laptop is rebuilt yet. A rebuild retires the laptop record, and a fresh
   laptop cannot be set up while the pool's anchor is stopped. Every employee
   shows `waitingFor: the shared pool, which the office is recovering after a
   host restart`, and no attempt of anyone's ladder is spent. That holds on
   every path that leads to a rebuild: a laptop that has been starting for
   fifteen minutes, a code the office does not recognize after its thirty
   minutes, a lost terminal whose input is held and a parked start-up screen
   all meet the same wait once a read finds no laptop of the employee running.
   While the pool is known to be down, no set-up request is sent again and no
   fresh laptop is started either, and a held plan move is neither continued
   nor closed: when the pool is back the move is continued as often as any
   other, and closed after that if it is still held.
3. The supervisor recovers the pool. It looks at the pool once a minute while no
   employee who should be in the office has an attached terminal, and never
   while one has. The first look only reads. One minute after the pool was first
   seen stopped it makes the same two calls an owner would:
   `docker-pool/cold-preview`, then `docker-pool/cold-recover` with that
   preview's digest, through the service behind those routes. The service
   itself refuses while any laptop of the box runs, while an earlier pool
   writer is not accounted for, or when the anchor is not stopped; the
   supervisor decides none of that and never takes a failed read for a stopped
   pool. Any employee's laptop record can stand for the pool, those in the
   office first. When the preview is refused through one record, whatever the
   refusal, the next record is tried. Nobody is started or returned to the
   office by this step. The table below says what the step does in every
   state a host restart can leave.
4. Once the anchor runs, each employee is taken through the ordinary steps: the
   stored home is read (next section), the laptop is rebuilt, and the fresh
   laptop is started, which resumes the saved conversation. Two steps are
   started per thirty-second pass, in the office's start-up order (employees on
   a local model first, who wait for no sign-in).

The limit of two rebuilds per laptop per day does not apply to this rebuild and
is not used up by it. The limit is for a laptop whose earlier rebuilds did not
hold. A laptop that was stopped from outside did hold: the sign of it is that a
read finds no laptop of the employee running and the laptop's storage holder is
stopped as well. A holder runs nothing of the employee's and never stops with
its laptop, so a laptop that crashed, was killed for memory or was stopped by
hand leaves it running, and that rebuild is counted as before. Rebuilding a
laptop that is stopped discards nothing that runs. So three or more host
restarts in a day bring every employee back each time. `supervisor.last` of such a rebuild
carries `uncounted`. Everything else a rebuild
needs still holds for it: the layout, the pool, the stored home, the two
attempts of a round and `supervisorAutoRepair`.

What the pool step does, by what it finds. In every row the office looks again
one minute later, and `supervisor.pool` shows the finding (`pool`, `detail`),
the step it will take (`step`), when it looks again (`nextLookAt`), when it
takes the step (`stepAt`) and since when the pool has not been up
(`downSince`).

| What the office finds | What it does |
| --- | --- |
| The anchor runs and its observation is on record | nothing; `pool: up` |
| The anchor runs and only its observation record is missing | `reconcile-pool` after one minute |
| The anchor runs and its limits or their acknowledgement are missing | nothing cold; `pool: up`, and the limits check puts them back in place |
| The anchor is stopped, by any exit status, killed for memory, or left by a start that failed | `recover-pool` after one minute: preview, then recover |
| A recovery was issued and did not finish | `finish-pool-recovery`: the same attempt is finished as itself, through the employee it was issued for first |
| The anchor is stopped and a pool helper was created and never started, or ended (with any status) before the office recorded it | the helper is proved unable to write anything more (a configured image, its fixed configuration, never started or ended, twice the same) and the pool is recovered past it. Nothing is read from it and nobody starts it |
| The anchor is stopped and a pool helper still runs, or is of an image this office is not configured with | `pool: down`, `DOCKER_POOL_COLD_WRITER_UNCONFIRMED`; recovered once the helper has ended. One of an unknown image has to be removed by the owner |
| The anchor is stopped and a laptop on record no longer exists | the Engine is asked for exactly that ID; a laptop it positively reports absent runs nothing, and the pool is recovered. One that is there and cannot be read stops the step |
| The anchor is stopped and any container with this box's laptop label runs, is paused or is restarting, on record or not | `pool: down`, `DOCKER_POOL_COLD_WORKERS_RUNNING`; recovered once none does. The office never stops a laptop for this |
| The anchor is paused or restarting | `pool: down`, `DOCKER_POOL_COLD_ANCHOR_NOT_STOPPED`; recovered once the Engine reports it stopped |
| The Engine reports the anchor dead | `pool: down`, `DOCKER_POOL_COLD_ANCHOR_DEAD`. A dead container cannot be started and the office has no operation that removes an anchor: the owner has to remove it. A host restart does not leave this state |
| The anchor on record is gone, or another container is the anchor now | that record cannot stand for the pool and the next one is tried. When none can, `pool: none`: nothing is waited for and the next laptop set-up creates or starts the pool |
| Employees are approved with different pool limits | `pool: down`, `DOCKER_POOL_COLD_POLICY_CHANGED`. A policy carries no time of approval, so the office cannot tell the newer one and does not choose: the owner approves one for everyone |
| The pool cannot be read at all | `pool: unknown` with the code. Never recovered cold. Rebuilds, starts and re-sent set-ups wait for fifteen minutes, then go on as they would without the look |
| `supervisorAutoRepair` is off and the step would start the anchor | the step is not taken; `stepNeedsRepairSwitch`, and the report names the switch and the calls |

While the pool is stopped every employee who waits for it shows
`waitingFor: the shared pool, …`. Once it has been stopped for fifteen minutes
without a break the same employees show a `needsHuman` that names the cause
with the refusal's own code, and the time of the next step. That is information
only: the office goes on looking every minute and brings everyone back by itself
once the cause is gone.

A recovery that fails is tried again one minute later, then after 5, 15 and 60
minutes, then every hour for as long as the pool is down. Nothing here
stops for good. A recovery that was issued and did not finish (the office
stopped, an Engine reply was lost, the helper failed) is finished as itself
before anything else: its anchor start is repeated only when every native fact
is still exactly what it was issued for, its helper is observed under its own
journal cursor and never created or started twice, and it ends either with the
published pool observation or, when it can write nothing more and confirmed
nothing, recorded as ended. Only a helper that cannot be proved to have ended
keeps it held, and that is read again at the same pace. A pool that runs and
only lacks its observation record gets that record (`docker-pool/reconcile`).

Each step is an audit entry (`supervisor_recover_pool`,
`supervisor_finish_pool_recovery`, `supervisor_reconcile_pool`, target `shared
pool`) and one console line `[supervisor] shared pool: …`. While the supervisor
is looking, `GET /api/company` shows `supervisor.pool` on each employee: `pool`
(`up`, `down`, `unknown`, or `none` when no laptop record names a pool yet),
the `step` it calls for, `attempts`, and `last` (the last step and how it
ended). Starting the stopped anchor needs `supervisorAutoRepair`; with it off
the supervisor only looks and the console line names the calls.

What this does not cover, stated plainly:

- A laptop whose set-up had not finished when the host went down has no
  finished record whose holder says so. Its rebuild is counted against the
  limit per day like any other.
- A pool that cannot be read (its status is refused for a reason other than a
  stopped anchor) is never recovered cold. The look is repeated every minute
  and `supervisor.pool.detail` carries the code. Rebuilds, starts and re-sent
  set-ups wait for it for fifteen minutes and then go on.
- A pool helper that ended with status 0 before the office recorded it does not
  stop the cold start, but the pool observation that follows is refused
  (`DOCKER_POOL_ORIGINAL_ACK_CHANGED`) until the operation that owns the helper
  has recorded how it ended. The anchor runs by then, so that operation can go
  on. This path is reasoned from the code and has no test of its own.
- When no laptop record, current or retired by a rebuild, names the pool, the
  stopped anchor cannot be recovered by anyone. That is an office that never
  finished a laptop, where the first set-up creates the pool.
- This is source and component coverage. A restart of a real host has not been
  qualified with it.

### The stored home of a stopped laptop

A rebuilt laptop is bound to the home path of the laptop it replaces. After a
host restart that path can hold something else: a disk that was not mounted, or
another filesystem at the same place. So before the supervisor rebuilds a
finished laptop that is stopped, it reads whether the HOME and Nix directories
at the recorded paths are still the ones the laptop's storage holder recorded
(device number, inode, owner and mode). It is the read a same-plan recovery
makes before it reserves a move, made by the pinned verifier, and it changes
nothing.

There are three kinds of answer, and the office never takes one for another.

| Answer | Finding | What the supervisor does |
| --- | --- | --- |
| Confirmed the same | The same directories on the same device number | rebuilds |
| Confirmed the same | The same directories, a new device number, and the filesystem is the one the office itself recorded for this employee earlier | rebuilds |
| Confirmed the same | The same directories, a new device number, the office holds no record of this employee's storage, `acceptStorageRenumbering` set | rebuilds, and records the filesystem for the next time |
| Confirmed not the same | The same directories, a new device number, no record, the grant off | never rebuilds on it; reads again every ten minutes; `needsHuman` names the setting and the approval route |
| Confirmed not the same | The same directories, a new device number, and the office's record names other directories | the same; the grant does not apply, because it is for the case without a record |
| Confirmed not the same | These directories are on record on another filesystem | never rebuilds on it, with or without the grant |
| Confirmed not the same | Another inode, owner or mode | never rebuilds on it; reads again every ten minutes |
| Confirmed not the same | The verifier refused the recorded directories, and the image cannot read what is mounted to say why (`changed`) | never rebuilds on it; `needsHuman` names the image |
| Could not tell | The helper did not answer in thirty seconds, twice in a row for each read; the configured image is not in the Engine; the holder container or its record of the directories is gone; the laptop container cannot be inspected | does not rebuild. Reads again after 1, 2 and 5 minutes and then every 10. After 30 minutes of the same cause without a break, `needsHuman` names that cause and the number of reads; the office goes on reading and rebuilds by itself once a read confirms the home |
| Nothing to check with | No recovery helper image is configured at all (`recoveryHelperImageId` absent) | rebuilds by the recorded path, as before this check existed |

A read that could not tell is never treated as a home that may be rebuilt on.
That holds for the rebuild step as well, which makes the read once more itself:
when it stops the step, nothing was tried and the attempt is given back, so a
round's two rebuilds are not used up by a helper that timed out.

What the office can check depends on the recovery helper image it is
configured with, and that image is pinned separately from the office build. At
office start the office probes the image once, writes one console line
`[supervisor] stored home check: …`, and shows the result on every employee as
`supervisor.storedHomeCheck`:

| `storedHomeCheck` | What the office does with it |
| --- | --- |
| `full` | everything in the table above |
| `compare-only` | the image was built before the read of what is mounted existed. An unchanged home is confirmed and rebuilt on. A changed one is refused by the verifier and never rebuilt on, but a new device number cannot be told from another directory, so neither the record nor the grant can accept it, and no record of a filesystem is made |
| `image-missing` | the configured image is not in the Engine. Nothing can be confirmed; no stopped laptop is rebuilt until it is loaded |
| `unknown` | the probe did not answer; the first read settles it |
| `none` | no image is configured; nothing is checked |

Device numbers of one filesystem can change across a restart. The office
proves that case itself: while a laptop runs, it records the kernel filesystem
ID of the ext4 filesystem the two directories are on, in
`docker-storage-identity.jsonl` beside the company store. Because the next
restart may come at any time, the records are made promptly: two laptops per
thirty-second pass from the first pass after an office start, those of
employees in the office first, so that every running laptop has its record
within a few minutes. Every finished laptop is recorded alike, whether a
set-up, a rebuild or a plan move made it, and wherever its employee is. A
laptop operation is recorded once and a new one (a rebuild, a plan move) again.
An attempt that recorded nothing is tried again after 1, 5, 15 and 60 minutes
and then every hour. The console shows `[supervisor] … record-home -> …` when
a home is recorded and when an attempt first records nothing. Recording needs
`supervisorEnabled` and a recovery helper image whose `storedHomeCheck` is
`full`.

The file is read with its damage told apart. A last line that was never
finished is what an interrupted write leaves: it is left out, every earlier
record stands, and the next record starts a clean file (the old one is kept as
`.previous`). A line in the middle that does not read cannot come from an
interrupted write, so nothing in that file is trusted: it is neither a record
nor the absence of one, it proves nothing, and the grant below does not apply
while it stands. The next record that is made sets the file aside as
`.damaged`, says so in the console and begins a new one. The ID is derived from the filesystem's own identifier and does not
change with the device number. A later renumbering is accepted when that ID and
both inodes match, and the verifier then confirms the renumbered reference with
the filesystem ID on both mounts, twice, exactly as it does for an owner's
approval. The record is only ever compared; it selects no path and authorizes
no write.

When the office holds no record of an employee's storage, the owner's standing
grant decides: `acceptStorageRenumbering` (`PUT /api/company/settings`, owner
only, absent means off). With it the office accepts a new device number while
both directories are otherwise unchanged on one ext4 filesystem. The grant is
for the case without a record only: a record that does not match what is
mounted is never overridden by it. It never accepts another directory, a
filesystem that is not ext4, or directories on two filesystems. The owner's approval for one laptop
(`POST /api/company/employees/:id/docker-storage/device-approval`) works as
before and takes precedence. The same rules serve a plan move that reads a
stopped laptop.

The policy asks for this read before it allows the rebuild (`stored-home`), the
driver makes it, and the rebuild step makes it once more itself, last, whatever
led to the rebuild. A stopped laptop that is reached by another rule (one the
office could not read for two hours is rebuilt as a laptop an agent may run in)
is therefore refused by the step on the same two findings.

Nothing here is a final stop: a finding that holds a rebuild is read again every
ten minutes, `needsHuman` says what was found and what settles it, and the
laptop is rebuilt by the supervisor as soon as the recorded directory is there
or the renumbering is accepted. What remains for the owner is a real change of
disk: mounting the right filesystem, or deciding that the directory that is
there now is the employee's home (rebuild by hand).

### A plan move that stopped part-way

A plan move that stops part-way is `recovery-required` and keeps its error. The
supervisor never keeps such a move for the owner. Every held move is continued
while that can help and is then closed, whatever stopped it and whatever its
record offers. No sentence about a held move asks for a person.

| What the move shows | What the office does | When |
| --- | --- | --- |
| Any error, and the record offers `continue-original` | Continues the original | 1, 3 and 8 minutes after the problem was first seen |
| Still held on the same error after that | Abandons the move | 15 minutes after that error was first seen, and once more 5 minutes later if the first attempt was refused |
| An error the office does not recognize, or no error | The same: three continues, then abandon | The same |
| A decision screen in the new session | The same: three continues, then abandon | The same |
| The sign-in screen of the new session | The same: three continues, then abandon. Nothing waits for the plan to be signed in (below) | The same |
| An operation that only has to finish, or something every laptop shares (the pool's limits, the office's configuration) | Three continues, spread as probes: 1, 10 and 30 minutes after the problem was first seen | Abandons 3 minutes after the last probe, if that probe found the cause still there |
| Any error, while the office's own look finds the shared pool down (its anchor stopped or a recovery open, as after a host restart) | Waits and spends no continue | Not abandoned while the pool is down; once it is back, three continues and then the abandon, as above |
| No `continue-original` offered | No continue | Abandons after 15 minutes |
| More than one open move of one employee | Continues none; closes them oldest first, one at a time, until one is left, which is then continued like any other | 15 minutes after each one is first seen; the two abandon attempts of an episode are shared by them |
| A held move from before the laptop runtime | Closes it (below) | After 15 minutes |
| A step of the move is running | Nothing, while the step comes back. A step that does not is given up by the move service itself (below), and the move is then held like any other | After 10 minutes without a sign of life, or when its phase has lasted 15 or 45 minutes |

The thirty minutes cover the repair of the pool's limits and the other causes
the office does not see directly.
Only a continue can tell whether such a cause is gone, so the three continues
are probes and the last one is held back until the thirty minutes are over. A
move is abandoned for such a cause only after that last probe failed: never
because all its probes fell inside an outage that then ended. A second code of
the same outage is the same problem and does not start the thirty minutes
again. If the three continues of a round were already used on an earlier error
of the move, nothing is abandoned in that round; the next round, six hours
after its last attempt, continues the move first. A move that offers no
continue cannot be probed and is abandoned when the thirty minutes are over.

A host restart is not left to those thirty minutes, because there the office
sees the cause itself: while its own look finds the pool down, a move is
neither continued nor closed, however long the recovery takes
([after a host restart](#after-a-host-restart)). Nothing was tried for it with
a pool that works, and no laptop could be rebuilt or started in its place
either. No probe is spent against a pool that is known to be down; once it is
back the move gets its continues and then the abandon. A move whose error is a
stopped storage holder (`DOCKER_CONTINUATION_STORAGE_UNCONFIRMED`) is a step of
the move itself: no other repair starts a holder again, so it is continued
three times and then closed after the usual fifteen minutes, and the laptop is
rebuilt.

A move that stopped at the sign-in screen of its new session is not waited
for, whatever the office reports about the plan. That screen is reached only
after the move has launched the agent in the candidate laptop, and the
candidate keeps the plan's sign-in in a folder of its own. Signing the plan in
at the office afterwards does not reach that folder; the office places no
sign-in there for a held move; and a sign-in typed into the candidate changes
the account material the move installed, which the move's own check then
refuses (`DOCKER_PLAN_ACCOUNT_AUTH_CHANGED`). A continue therefore finishes such
a move only when the candidate got past the screen by itself. The three
continues look for exactly that, and then the move is abandoned. From then on
the employee is an ordinary employee on that plan and the laptop's own sign-in
repair applies. If the plan is signed out everywhere, it is that repair which
waits for the plan to be signed in, by the owner or by another route. The move
does not.

While a move waits out those thirty minutes, `waitingUntil` gives the time at
which it is closed. A move that is still held after both steps were used,
because the service refused to close it, is not left there: like every path,
its round starts again six hours after its last attempt, with the three
continues first and then the abandon.

After an office restart the times above still count from when the move's error
was first seen, so a move whose three continues were used before the restart
would be due for the abandon at the new process's first look. A restart puts
right some of what stops a move, because every terminal is attached again and
the laptop configuration is read afresh. The new process is therefore given
one of those continues back: it continues the move once itself, watches the
outcome for the usual three minutes, and only then may close it. This happens
once in a round. An office that restarts again with the move still held gets
nothing more and closes the move as before, so repeated restarts cannot
continue a move for ever. A continue repeats no paid step, whoever asks for it.

Continuing uses `supervisorEnabled`; abandoning and closing use
`supervisorAutoRepair`. Each step is one audit entry
(`supervisor_continue_move`, `supervisor_abandon_move`) with the move, the
class of its error and the outcome. Asking twice is safe: a move that has ended
is answered with `already closed` and nothing is written.

**A step that never returns.** A move's step is a chain of short waits, each
with its own limit: a container engine command ends after thirty seconds, the
wait for the employee to yield after five minutes, a read of the new session's
composer after three. Between them the step passes a checkpoint. What has no
limit of its own is a wait on the office itself, such as an audit entry, a
company record or the launch. The move service therefore watches every step of
a laptop move. It gives a step up when no checkpoint was passed for ten
minutes, which is twenty times the longest wait that has a limit, or when its
phase has lasted longer than fifteen minutes (waiting for the employee,
checking the target, stopping the source) or forty-five (building and starting
the new laptop, checking it). Both are well above what the phase takes even if
every one of its waits ran to its limit.

A step that is given up is first told to stop. One that is waiting in a loop
ends there, and the move is held in the usual way. One that has not ended a
minute later is stuck in a wait that never returns, and the move is taken from
it: the move is held with what its journal last recorded, exactly as an office
restart would leave it, and its sentence says that the office stopped waiting
and that the step's outcome is not known. The stuck step can do nothing
afterwards, because every effect and every journal write of a step is behind a
checkpoint, and those now refuse. Nothing is repeated: a launch whose intent
is in the journal stays there, so the continue that follows only reads and
verifies. From there the move is an ordinary held move: three continues, then
the abandon. A move that had already completed stays completed; only the
retirement of its old terminal is reported as unconfirmed. The line
`[plans] move … The office stopped waiting …` is written, and the plan move
audit records the hold. This watch belongs to the move service and has no
switch, like the limits of the single waits. It covers laptop moves only.

**Paid steps.** A move launches the agent in the new laptop once, and records
that launch before it issues it. The office never repeats it and never starts
one. Continuing a move whose launch is on record only reads and verifies what
exists; the journal refuses to hand such a move to a new actor. Abandoning
takes no executor and no requester at all: it cannot issue, repeat or inspect a
launch, and it keeps the launch record exactly as it was.

**What abandoning changes.** It writes the move's journal and nothing else. The
move is closed as `failed`; its sentence says that the office closed it on the
owner's standing rule and what it had stopped with; the employee is no longer
locked by it; the containers its journal named are recorded for the laptop
rebuild. Nothing is started, stopped or removed by the abandonment itself.

**Where the employee is afterwards** depends on how far the move had come. A
move switches the employee's record to the new plan and the new session
immediately before it launches the agent there.

- The move stopped before that. The employee is still on the plan and the
  session they came from. If the move had already stopped their laptop, the
  ordinary steps above take over: the stopped laptop is rebuilt and started,
  the home directory and the conversation saved in it are kept. That rebuild
  also removes what the move left behind: its candidate laptop, the holder of
  the stopped source and its helpers. A candidate that is still running holds
  no agent, because the move starts the container before it launches one; the
  supervisor's rebuild discards it once a read inside it, made immediately
  before, finds no agent. A candidate in which anything runs, or which cannot
  be read, is not discarded.
- The move stopped after that, which is always the case when it stopped at a
  sign-in or decision screen of the new session. The employee stays on the new
  plan and the new session. Abandoning does not put them back: only a plan move
  changes a plan, the office never starts one, and a session a move has
  replaced is never revived. From then on they are an ordinary employee on
  that plan, and the repairs that the held move stood in front of apply to
  them: putting the plan's sign-in back, the start-up screens, the rebuild. The
  handoff text the move had not typed yet is not typed. The stopped laptop of
  the old plan is removed by the next rebuild, as after a move that finished.

**A held move from before the laptop runtime** has no laptop journal. It gates
no laptop, but it keeps its employee locked against every later plan move. The
supervisor closes it and keeps the employee where they work now. When the
employee already works on the session that move was creating and its source
cleanup is durably recorded, it uses the owner's own adoption
(`adopt-existing`, see [plan move recovery](plan-move-recovery.md)). Otherwise,
or when the adoption's checks refuse, it closes the record as `failed` with the
reason. Both change the journal only. This is done only for an employee who
works in a laptop, and only with `supervisorAutoRepair` on; with it off such a
record is not shown, as before. A record of a resource transaction keeps its
own recovery and is not touched or shown. A closing step that was refused is not tried
again for six hours, and in that time the record does not stand in front of
the laptop's own repair.

### Provider start-up screens

An agent CLI can show screens before its composer: a theme chooser, security
notes, a workspace-trust question, a permissions warning, a question about an
API key, a sign-in screen. No employee is left on one of them for the owner.

- **Screens with one answer** are answered by the office terminal itself while
  the agent starts: the theme chooser, the security notes, the workspace-trust
  question and the Bypass Permissions warning. One key is sent per read of the
  screen, Enter only once the selection mark is on the accepted option, at
  most six keys per screen.
- **A decision has a standing answer**, the one that spends no money, buys or
  enables no usage credits and widens no access. Claude's "Do you want to use
  this API key?" is answered "No (recommended)": a key found in the
  environment would be billed for every request. It is answered under the same
  key rules. No setting exists for it, because the other answer is not safe.
- **A sign-in screen is never typed into.** The office never types a
  credential, a code or a password, and never presses a key on a screen it has
  not positively identified. What it does instead is below.

The supervisor reads each attached employee's screen once a minute, and on
every pass while it shows a start-up screen. Three conditions cover them:

- `waiting-first-run-screen`: the office terminal is still answering the
  screen. Nothing else is done.
- `needs-sign-in`: the agent shows the provider's sign-in screen. The
  office first asks the plan sign-in reconciler to read every copy of that
  plan's sign-in now and to put a usable one into the laptop
  (`replace-sign-in`; it discards nothing, so it also runs with
  `supervisorAutoRepair` off). A client reads its sign-in when it starts, so
  once the laptop holds a usable sign-in and the screen is still there, the
  placement is not repeated and the agent is started again. The same holds
  when the laptop has no sign-in folder of the plan (a seat folder for another
  plan, a provider whose sign-in the reconciler does not carry): only a new
  laptop gets one, and a rebuild places the office's copy in it.
- `stuck-first-run-screen`: a first-run screen the office terminal could not
  answer (its six keys were spent, the layout is one it cannot read), or a
  start-up screen it does not know at all. The agent is started again.

Starting the agent again is a relaunch inside the laptop where an office has
that step, and otherwise a rebuild of the laptop, which keeps the home
directory and continues the saved conversation. Under the boxed laptop runtime
the launch of an agent is made once per laptop and is never repeated, so here
it is the rebuild: three minutes after the screen was first seen, at most
twice per episode and twice per day, under `supervisorAutoRepair`.

An agent on a start-up screen has not reached its composer, so it is in no
turn and a rebuild discards no conversation. That is not taken from the
screen's name. The rebuild runs under the rule of every laptop an agent may run
in (above), with one more demand of its own, the first of these:

- The office knows the screen by more than its words. Either the frame shows
  the screen's own live widget (the selection mark on one of that screen's
  options, or its prompt as the last thing on the screen), or the office
  launched that pane itself and has not seen its composer since, and the frame
  shows no composer now. A conversation that quotes a screen shows the same
  words, so a screen known only by its words is never acted on: it is not even
  reported as a start-up screen.
- The office terminal shows the pane idle and silent for two minutes. A pane
  that still changes is waited for. Work the pane says was left running is
  given thirty minutes from the first sight of the screen.
- The screen and the idle pane are read again from the pane immediately before
  the step is issued, and once more by the step itself before the rebuild is
  requested. The running laptop is discarded only when it is the one recorded
  laptop of that employee.
- No plan move is open for the employee. A move keeps its own recovery. Once a
  held move is abandoned, an employee it left at a sign-in screen is an
  ordinary employee at that screen, and these steps apply.

When every step has been tried and the screen is still there, the office does
not stop: like every path, its round starts again six hours after its last
attempt, and `waitingFor` says when (the limit of two rebuilds per day stays).
A screen the office is still answering itself is never treated as a laptop that
has been starting for too long: the answering ends within five minutes, and the
screen is then gone or the agent is started again.
A screen the office does not answer is written to the office log once per
launch as its shape: its last sixteen rows with links, addresses, paths, keys
and every long run of letters and digits removed, so that a table row can be
written for it (`[Session] … is parked at …`).

**A plan that is signed in nowhere** is the one thing the office cannot repair:
only the account holder can sign a plan in, on the Plans page. Everything
short of that is done:

- It rarely arises. Each copy of a Claude plan sign-in (the office's and every
  laptop's) is renewed by its own client, and the reconciler carries a renewed
  copy to every other holder within a minute, in both directions (seconds
  around the moment a shared sign-in is renewed). A copy the provider refused
  is never placed again. A rebuild places the office's current copy in the new
  laptop.
- It is known early. When two reads in a row found every holder of a plan
  without a usable sign-in, one line is posted in the office room: the plan,
  the employees who run on it, and that only the account holder can sign it
  in. An agent that is running goes on until its next request. One more line
  follows when a sign-in is held again. The notice state is kept in memory, so
  an office restart repeats the line once for a plan that is still signed out.
- The employee is not rebuilt for it: a new laptop would stop at the same
  screen. The card reads "Needs a sign-in" and `needsHuman` says so. As soon
  as the plan is signed in, the reconciler puts the sign-in into every laptop
  and the supervisor starts the parked agents again, with nothing else to do.
- An office that is merely signed out itself is not that case: while the
  laptop still holds a sign-in that works, the agent is started again with it.

The office does not renew a sign-in itself and does not move an employee to
another plan by itself; see the gaps below.

Current gaps: the reconciler carries Claude plan sign-ins only. A Codex laptop
at its sign-in screen is repaired by the rebuild, which places the office's
copy of `auth.json`, but its copies are not kept in step between rebuilds.
The office holds a sign-in's refresh token inside its copy and never uses it:
renewal is done by a provider client (a laptop's agent at its next request),
not by the office. An employee whose plan is signed in nowhere is not moved to
another plan automatically: a plan move launches a paid session on the
destination plan and is admitted only for the owner's own request, and the
supervisor can continue a held move but never choose a plan. The per-model
limit fallback (`modelLimitFallback`) changes the model within the same plan
and does not help a plan that is signed out. After an office restart the
office has no record that it launched a pane, so a screen it can only know by
its words is recognised again at that laptop's next launch; a sign-in screen
is recognised at once, by its widget. The reconciler leaves the laptop of an
employee with an open plan move alone: the move installed the account material
it reserved in a folder of its own and verifies exactly that material, so a
sign-in is not placed for a move that waits at a sign-in screen. A start-up screen that no table row
names is recognised only for a CLI that declares both its composer mark and its
composer glyph (Claude Code, Codex, OpenCode), because for any other the office
cannot show that a pane is without a composer.

## Employee disk budget

Every employee has a fixed disk budget of 20 GiB for their case folder, the
working directory of their saved session under the shared cases directory. Case
folders hold cloned git repositories only. Useful work is pushed to GitHub.
Anything kept permanently needs the owner's approval and goes on the shared
company drive. The shared Nix store does not count against the budget.

The office measures each registered employee's case folder every 30 minutes,
starting about five minutes after it boots, one folder at a time with a
low-priority `du` limited to that filesystem and to ten minutes. A folder is
measured only when it is a real directory strictly under the cases directory;
a symlinked, missing or unreachable folder, a failed or timed-out measurement
and an employee whose cases live elsewhere (per-user case spaces in multi-user
mode) read `unknown`, never empty. Entries `du` cannot read are left out of the
total, so a reported size is a lower bound.

An employee over budget is told in their own session, as one typed prompt, to
clean up. The notice is sent when the folder newly goes over and then at most
once every six hours while it stays over. It is typed only into a live session
that is idle, not held and showing no dialog; otherwise the office tries again
on the next cycle. Employees on vacation or stopped are measured but not told.
Measurements and notice times are held in memory, so a restart measures again
and repeats the notice for an employee still over budget.

`GET /api/company/disk-budget` (owner only, read-only) returns the budget and,
per employee, `usedBytes`, `measuredAt`, `state` (`ok`, `over` or `unknown`) and
`lastNotifiedAt`. There is no write endpoint and the budget is not yet
configurable.

Current gaps: only the case folder is measured. An employee's private home and
scratch storage are not measured and do not count yet, nothing is deleted or
blocked automatically, and the owner is not alerted separately.

## Employee group CPU ceiling

All employee laptops of one office run under one pool cgroup,
`reverie.slice/reverie-box.slice/reverie-box-<box>.slice`. The owner can approve
a ceiling on the CPU time they use together, in whole CPUs. It is the pool's
kernel `cpu.max` (`<CPUs x 100000> 100000`), separate from every employee's own
resource policy, so approving or changing it alters no employee policy, digest,
acknowledgement, container or session.

`GET /api/company/docker-resources/cpu-ceiling` (signed-in owner only) returns:

- `approved`: the owner's current decision (`revision`, `cpuCores`, `cpuMax`),
  or `null`. `cpuCores: null` means the owner chose no ceiling.
- `proposed`: a suggestion for the approved pool CPU set, three quarters of its
  CPUs and always at least four left free (24 of 32). It is never applied by
  itself.
- `effective`: what a fresh read-only pool observation shows the kernel
  enforcing, or `null` when the pool could not be observed (`code` says why).
- `state`: `unapproved`, `pending` (approved, the kernel still shows none or an
  earlier approved value), `applied`, `drifted` (a value the owner never
  approved) or `unobserved`.

`PUT /api/company/docker-resources/cpu-ceiling` (signed-in, same-origin owner;
no worker, parent-session or service-token header) records a decision:

```json
{ "revision": "NEW_UUID", "expectedRevision": null, "scope": "all-employees", "cpuCores": 24 }
```

`expectedRevision` is the `approved.revision` the owner last saw, or `null` for
the first decision. A stale value is refused with
`DOCKER_POOL_CPU_CEILING_CHANGED`; repeating the identical request is accepted
once. A value above the pool CPU set is refused. Decisions are appended to the
private `docker-pool-cpu-ceiling.jsonl` beside the company store.

Recording a decision changes nothing in the kernel. Pool checks accept "no
quota" or a ceiling the owner approved (the current and the seven before it),
so a pool carrying an approved ceiling stays acknowledged; any other pool quota
is still an unapproved change. A worker's own cgroup never has a quota.

Current gaps: the office does not yet issue the write. The fixed helper has the
command (`configure-pool-cpu-max`, which writes only `cpu.max` on a populated
pool after the usual identity checks and keeps every laptop running), but no
helper image carrying it is selected in the runtime manifest and no apply
endpoint exists, so `state` stays `pending` after approval. There is no GUI
control. A host restart recreates the pool cgroup without a ceiling.

## CPUs reserved for the owner's system

By default every employee laptop may use every CPU of the approved pool CPU set
except the host's first physical core: CPU 0 and its SMT siblings, read from
`/sys/devices/system/cpu/cpu0/topology/thread_siblings_list` (on a 16-core,
32-thread host that is CPUs 0 and 16, so laptops get `1-15,17-31`). There is no
CPU quota; laptops share the remaining CPUs at their approved CPU weight. A host
whose only core is the first one reserves nothing.

The reservation is applied to the resource policy of each NEW laptop operation:
a newly approved employee, a laptop started after a rebuild, and a plan move.
It takes the reserved CPUs off the laptop's `allowedCpus` (the container's
`--cpuset-cpus`, confirmed by the usual cgroup readback). A laptop that may use
the whole pool CPU set gets the pool CPU set minus the reservation, so a smaller
reservation gives CPUs back; a laptop the owner limited to fewer CPUs keeps its
own set minus the reservation. The pool's `allowedCpus` is never changed: every
laptop of the box shares the one live pool cgroup, and a laptop CPU set is
always a subset of it. A laptop operation already on record keeps the CPU set
its owner approved and its policy digest; nothing is rewritten in place.

`GET /api/company/docker-resources/cpu-reservation` (signed-in owner only)
returns the host `topology` (`onlineCpus`, `firstCoreCpus`), the
`defaultReservedCpus`, the owner's `approved` decision or `null`, the
`reservedCpus` in force and their `source` (`default` or `owner`), the shared
`poolCpus`, and per employee the `operationCpus` of the laptop on record,
the `nextCpus` a new operation would get and a `state`:

- `applied`: the laptop on record already runs on that CPU set.
- `next-start`: no laptop operation is on record; the next start takes it.
- `rebuild-required`: the running laptop keeps its approved CPU set until it is
  rebuilt or moved to another plan.
- `refused`: the reservation would leave this employee no CPU (`code`).

`PUT /api/company/docker-resources/cpu-reservation` (signed-in, same-origin
owner; no worker, parent-session or service-token header) records a decision:

```json
{ "revision": "NEW_UUID", "expectedRevision": null, "scope": "all-employees", "reservedCpus": [0, 16] }
```

`reservedCpus` is a sorted list; `[]` reserves nothing. Every CPU must be online
(`DOCKER_CPU_RESERVATION_CPU_OFFLINE`) and at least one online CPU must remain,
also for every employee's approved policy
(`DOCKER_CPU_RESERVATION_LEAVES_NO_CPU`). `expectedRevision` is the
`approved.revision` the owner last saw, or `null` for the first decision; a
stale value is refused with `DOCKER_CPU_RESERVATION_CHANGED`. Decisions are
appended to the private `docker-cpu-reservation.jsonl` beside the company
store. An unreadable host topology offers no decision
(`DOCKER_CPU_TOPOLOGY_UNKNOWN`) and reserves nothing by default.

To move an existing employee onto the CPU set, rebuild the laptop once nothing
in it matters (`POST .../docker-rebuild/preview`, then `.../apply`), read
`GET .../docker-policy` (its `policy` and `policyDigest` now carry the new
`allowedCpus`) and continue the laptop with that `expectedPolicyDigest`; the
supervisor's own rebuild continues the same way. A plan move also takes the
current CPU set. A rebuild discards the laptop terminal's conversation; home,
memories, shared Nix store and session identity are kept.

Current gaps: there is no in-place re-enforcement of a running laptop's CPU set
and no GUI control. The pool cgroup and short-lived resource helpers still run
on the whole pool CPU set.

## Retained expert startup

After a reboot, the ordinary session restore banner and its API offer personal
sessions. The company lifecycle service owns recovery for employees, including
employees on vacation. Retired employee sessions stay out of the offer. The
automatic pinned-session restore checks this same boundary again before launch
in case an employee acquired the session after the offer was created.

The template-hiring API keeps employment (`active` or `retired`) separate from its
startup journal. New hires move from `prepared` to a durably recorded `issued`
before launch. `launch-returned` means the launch adapter returned; it is not
evidence that an employee is online or ready. A rejected launch keeps the same
employee, session, generation, rooms and hire record as `recovery-required`.
An identity-binding or pre-launch refusal can leave `not-issued`; it does not
authorize another launch. Notice and audit confirmations are reported separately
and never cause a launched employee to be deleted or stopped.

Owner-approved requests retain a closed creation reservation before invoking
session creation. `creation-issued` carries no SID and makes no claim that a
session exists; only `session-bound` carries the actual returned SID before
canonical employee creation. An unresolved reservation counts against
capacity. A linked approval cannot be approved again or declined to reset its
startup. Inspect `GET /api/experts` and the employee profile; use only existing
explicitly authorized recovery workflows. This journal neither enrolls a new
employee into an already-installed native pool nor grants resource authority.

The experts store reads version 1 records as `legacy` without inventing a launch
receipt. The next confirmed write uses version 2. The previous version-1 reader
rejects version 2 on a fresh load, but a previously loaded old process can cache
version 1: migration requires a single stopped old writer and one new writer.
Do not run an older console concurrently or downgrade it over the version-2
store. There is no cross-process CAS in this store.

A write rejection may occur after rename. An exact private authority refusal
from the canonical writer's pre-rename callback proves that publication did not
occur and leaves the writer usable. Other write failures remain ambiguous. The current process blocks further
hiring writes and session creation rather than overwriting disk with its older
cache. A fresh process reads the stored journal without replaying startup.
Cross-store creation is not atomic: session creation without a returned SID,
or canonical creation before its first hire-record write, can still require
supported reconciliation or idempotent creation. An empty current list cannot
clear or replay an uncertain creation. No SID, missing record or reservation
is treated as absence proof, launch permission or native enrollment authority.
Hire diagnostics and requests are filtered by exact owner scope, including the
template detail route. Missing legacy owner values remain unscoped; they are not
assigned to a named owner. Templates, settings and capacity limits remain
instance-wide, so global quota counts can exceed the caller's visible hire rows.
Both owner and delegate template hires carry a private, revocable creation fence
through the ordinary authenticated session API. The exact request, payload and
owner remain bound across preparation and the layout lock; owner credentials
are not replaced with delegate credentials. A refused, unregistered Session
disposes local trackers without provider or mux signals. An error response never
authorizes destructive cleanup of a returned session ID.
Template hires recheck the same admission predicate, original Session object and
owner inside the canonical company-store lock and again before employee-record
publication. Room invitations are awaited and any failure is observed before
startup; they do not trigger deletion of the published identity.

## Unconfirmed provider dispatch and held approvals

Mandatory workspace-hook preparation must finish before a provider launch. A
successful file write is configuration evidence, not provider readiness. The
local process adapter reports a separate dispatch boundary; a positive PID
without that boundary does not prove a successful launch. If dispatch may have
occurred but completion cannot be confirmed, the Session retains its attempted
configuration and exposes `providerDispatchHeld: true` in its state. That field
is a persisted denial, not a capability: omitting it or sending `false` cannot
clear the private hold on an existing Session. Automatic retries and ordinary
input are refused. Read-only viewer attachment remains separate.

The original employee/conversation launch reservation becomes nonexpiring while
dispatch is in progress or unconfirmed. A predecessor cannot release a newer
reservation. These reservations currently live in the console process; durable
before-dispatch journaling and crash reconciliation are still required. Inspect
the existing terminal and preserve the original Session identity. There is no
supported same-Session API to clear this hold. Restarting the console is not
proof that the original provider stopped and does not authorize replay.

`GET /api/approvals` and approval SSE events project `answerState: current` or
`answerState: held`, with a diagnostic `heldReason`. The server binds answer
authority to the original Session, provider epoch and owner account; the GUI
does not grant that authority. An answer that may have reached the terminal
stays held rather than being automatically resent. Human clients retain their
draft and disable answer buttons; API clients must inspect the conflict and
wait for a genuinely current prompt. Refreshing an inbox cannot certify an
unconfirmed answer as safe to repeat.

## Unconfirmed canonical replacement publication

Candidate cleanup on a failed replacement carries the original in-process
Session, owner, local transport record and PID identity through storage waits,
the owner layout lock, and process termination. Losing that identity refuses
cleanup; it does not authorize stopping a successor with the same session ID.
An unproved native/remote/container stop also refuses before changing running
intent. The API reports `candidate-cleanup-unconfirmed`, retains the original
replacement claim and intent, and requires recovery rather than replay.
Guarded cleanup preserves optional workspace/upload/subagent artifacts instead
of deleting them by session ID. It signals only the original verified local
process identities, requires observed pane death or absence, and preserves any
dead tmux pane rather than killing a potentially reused name. Live or unknown
readback requires recovery. This does not add native stop/reconciliation
authority or qualify the older unguarded cleanup paths.

Canonical employee replacement distinguishes a refusal before its current
rename was issued from an uncertain rename or later publication failure. The
current writer is held after uncertainty; it cannot overwrite the stored
binding from its previous cache. A known authority refusal before rename does
not poison that writer. This fence belongs to one process and is not a
cross-process exclusion or durable reconciliation journal.

Once a binding reservation has been published, a later room, validation,
publication or identity-notification error cannot authorize deletion of the
replacement Session, restoration of an older binding or rollback of running
intent. The API returns a conflict with `recoveryRequired: true`,
`reason: binding-publication-unconfirmed` and the original employee/session
identifiers. These are diagnostics: only the actual private service attempt
and original Session can produce the retained outcome. An obsolete attempt
never overwrites a newer Session or owner while persisting diagnostics.

A plan move receiving this conflict stays `recovery-required`, even when
creation did not return a candidate SID. It does not invent that SID, stop a
candidate, restore an old binding or offer another move. Human and headless
clients must preserve the operation and inspect the existing state. Supported
canonical binding reconciliation is not implemented. A restart, a fresh cache
or a readable row is not proof that an uncertain operation may be replayed;
coordinated old-writer exclusion and durable reconciliation remain required.

Fresh native-worker generation/configuration transport is not qualified by the
local process adapter tests or by Office header-forwarding tests. Native
enrollment, durable launch and canonical binding reconciliation remain release
blockers. Do not deploy this partial qualification
as proof of complete native employee recovery.

## Docker continuation correlation format

Version 2 keeps the original launch fingerprint and approved request unchanged,
and adds a separate fingerprint for observations of an existing provider. Only
the shipped native-thread codecs may omit runtime-owned conversation IDs from
that observational fingerprint. Owner, account, session generation, working
directory and provider configuration remain part of the binding. A fingerprint
never grants launch authority or replaces fresh container and native-process
identity checks.

Startup imports a version 1 record through the canonical company writer only
when its original fingerprint can still be reproduced. The narrow first-learned
Codex thread case also requires reproducing the exact original launch bytes;
unknown previous thread IDs are not guessed. This format import preserves the
request, resource approval, operation, credential, binding, phase and launch
fences. Each employee is migrated inside its own viewer-restoration boundary,
so a stale record remains held while unrelated viewers can reconnect.

Existing-provider correlation resolves an absent Claude permission mode through
the unchanged shipped protocol's selected default. Explicit permissions and tool
selections remain distinct; unknown or overridden protocols retain strict
comparison. Actual Session facts use a complete projection without view/runtime
getters, so checking a proof does not recursively invoke its serializer. The
original launch fingerprint remains unchanged and is still an additional check
before the first provider launch.

Both formats have explicit strict schemas. An older reader that does not
understand version 2 must refuse the store; it must not discard records or load
an older backup over them. Do not run competing old and new writers or downgrade
the data format by editing private files. These source contracts and synthetic
startup tests do not establish acceptance of a deployed image or grant recovery
of an uncertain paid launch.

## Reconcile a missing shared Docker pool acknowledgement

A completed pool helper can outlive the employee that originally owned its
journal row. The supported metadata-only observation path is
`GET /api/company/employees/:id/docker-pool/status`. A verified owner or an
agent with a current explicit `recoverEmployees` grant may inspect it. Existing
approved pool policy is required; this operation cannot approve or edit limits.

When the response offers `reconcile-pool`, submit
`POST /api/company/employees/:id/docker-pool/reconcile` with the returned
`sessionId`, `sessionGeneration` and `expectedScopeDigest` copied from
`scopeDigest`. The server repeats fixed-image/configuration, original successful
native log ACK, current anchor PID/birth, parent identity and pool-policy checks,
then records only global observation metadata through the canonical company
writer. It never creates or starts a helper, changes limits, launches a provider,
or clears an employee launch fence. No retired employee/session/origin UUID is
invented from helper labels. Multiple original successful helpers are accepted
when every discovered writer is fixed and terminal. An earlier epoch's ACK must
match a retained receipt for the same pool and policy. The current observation
requires a fresh ACK for the current native epoch. One verified task is selected
as new observation correlation, preferring an already retained proof; this is
not a claim about which historical operation caused the pool state.

`retained` reports the observation record, not permission to launch. Every
later resource use still needs its own fresh native proof. Running/unknown
writers, ambiguous or foreign helpers, changed epochs, missing original logs,
revoked authority and stale previews remain held. Unknown publication is not
silently retried. After restart, obtain the canonical record and original native
proof again.

Canonical company format 2 is published atomically when either retained pool
lineage or a re-earned observation becomes nonempty. Empty legacy format 1
remains readable; format 1 containing new retained pool metadata is rejected.

## Put approved limits back after a reload of the host service manager

A reload of the host's service manager (`systemctl daemon-reload`, and with it
every `nixos-rebuild switch`) makes systemd apply its own unit settings to
every cgroup again. Docker registers a laptop's hard memory and process limits
with systemd, so those survive. The limits that only the resource helper wrote
do not: the shared pool's memory, swap and process limits, and each laptop's
soft memory and swap limits, are back at "no limit". Nothing is stopped by
that, but no laptop reads as approved any more: every employee is held with
`DOCKER_CONTINUATION_POOL_UNCONFIRMED`, and once the pool is put right, with
`DOCKER_CONTINUATION_RESOURCES_UNCONFIRMED` (or
`DOCKER_RESOURCE_LEAF_ACK_MISSING` when the helper container that confirmed
the laptop's limits no longer exists).

The office repairs both in place, without stopping a laptop, and with the
supervisor on it does so by itself. The same two calls are open to a verified
owner and to an agent with a current `recoverEmployees` grant:

1. `GET /api/company/employees/:id/docker-pool/status` for an employee whose
   laptop is running. When it answers `held` with `allowedActions:
   ["repair-pool"]`, submit `POST /api/company/employees/:id/docker-pool/repair`
   with `sessionId`, `sessionGeneration` and `expectedScopeDigest` copied from
   `scopeDigest`. The office runs the pinned restore helper once (`restore-pool`
   with every running laptop bound by its process birth), reads the limits back,
   verifies the helper's acknowledgement and records the pool observation if
   none on record covers it. Sent again, it finds nothing to do and answers with
   the status. An empty running pool is written with `configure-pool` instead.
2. `POST /api/company/employees/:id/docker-continuation/repair` with the
   laptop's `operationId`, for each running laptop whose read offers `repair`.
   The office runs the leaf writer once (`restore-high`), which writes the
   laptop's approved swap, soft memory and CPU weight again and requires the
   limits Docker owns to be unchanged, then reads the laptop again. An agent
   that was refused only for its limits reads `ready` again and the office
   terminal is attached to it; nothing in the laptop is restarted.

   For an employee who is stopped or out of the office the same route answers
   `{ operationId, limits }` with `unchanged` or `restored` and reads nothing
   else: a laptop set-up is never continued for such an employee, but a laptop
   that still runs keeps its approved limits. The same proofs hold (the finished
   record, the unchanged employee and policy, the record's image, ready storage
   and a confirmed pool), nothing is attached or started, and attendance is not
   changed. A laptop that is not running is refused with
   `DOCKER_CONTINUATION_CONTAINER_STOPPED`.

What these calls cannot do: they take no limit and no policy. The values come
from the laptop's own approved record, and a pool repair is refused for an
employee whose record does not name the one pool policy every employee is
approved with. Neither one creates, starts, stops or removes a laptop, launches
an agent or edits a laptop record.

Each repair keeps its own durable cursor in `docker-resource-repair.jsonl`
beside the company store, written before the helper is created and before it
is started. An attempt whose reply was lost is observed as itself: a helper
that was created is not created again, one that was started is not started
again. A helper that exited with an error is recorded as failed, it
acknowledges nothing, and the next request issues one new attempt from a
freshly read pool. A helper that may still be running holds every reader of the
pool until it has ended. The restore helper refuses by itself when a laptop
started or stopped after the office read the pool; that attempt is recorded as
failed and the next one names the laptops that run then.

The same repair is what the pool step of a laptop set-up uses when other
laptops already run in the pool. `configure-pool` only initializes an empty
pool; the office no longer issues it against one that has members. A set-up
whose own pool helper exited with an error is recorded as failed when the
request is sent again, and then continues.

Refusals worth knowing:

| Code | Meaning |
| --- | --- |
| `DOCKER_POOL_RESTORE_HELPER_REQUIRED` | Laptops run in the pool and the office has no `poolRestoreHelperImageId`. Nothing was written. |
| `DOCKER_RESOURCE_POOL_RESTORE_UNSUPPORTED` | The selected restore image is not built for restoring. |
| `DOCKER_RESOURCE_MEMBERS_CHANGED` | A laptop started or stopped while the pool was read. Repeat. |
| `DOCKER_RESOURCE_HELPER_FAILED` | The helper exited with an error; the attempt is recorded as failed. Repeat. |
| `DOCKER_RESOURCE_REPAIR_REVISION_PRESENT` | The laptop has an owner soft-memory revision on record; apply that revision again or rebuild. |
| `DOCKER_RESOURCE_POOL_WRITER_UNCONFIRMED` | A pool helper on record may still be running. Wait for it to end. |

Limits of this workflow, stated plainly:

- `restore-high` is a command of the resource helper that an image built
  before it existed does not have. The office issues it with the leaf writer
  image (`leafWriterHelperImageId`, or the baseline helper image when none is
  selected), so that image must be a build that carries the command. With an
  older image the helper exits at once, nothing is written, and the laptop
  stays held with the repair still offered.
- A repair helper container is kept: it is the acknowledgement. Once a newer
  repair of the same pool or laptop is acknowledged and read back, the office
  removes the earlier repair helpers of that target itself (exited ones only,
  never by force, and never one the company record names), so a host that
  reloads often keeps one per target. The helpers of a laptop's own set-up are
  not touched by this.
- A repair helper that was recorded as about to be created and that the
  Engine does not list was never created (the Engine refused it, or the office
  stopped first). The next request closes that attempt as never created and
  issues a new one; only a helper recorded as created is ever started.
- A laptop record whose own pool helper is recorded as failed cannot be read
  by an office build that predates this workflow, which knew that state for a
  laptop's own limits helper only. Do not return to such a build once one is
  recorded.
- A laptop of an employee who is out of the office is not repaired until they
  return: the pool's limits bound it meanwhile, its own soft memory and swap
  limits do not.
- `docker-resource-repair.jsonl` holds at most 512 KiB. A full file whose
  attempts have all ended is set aside as `docker-resource-repair.jsonl.previous`
  and a new one is started.
- After a restore image selection changes, an acknowledgement written under
  the earlier image is no longer read. The pool then reads as unconfirmed with
  intact limits, and the repair re-earns an acknowledgement under the new image.
- The observation record that plan moves read is written by the pool repair
  call. When the pool was put right by a laptop set-up instead, the status
  reports `reconciliation-required` and offers `reconcile-pool` as before.

This source and component coverage is not evidence of a restoration on a real
kernel; that is qualified on the selected images, as described under
[native helper acceptance](testing/memory-high-native.md).

## Recover the shared Docker pool after a host restart

With the supervisor on, the office does this by itself
([after a host restart](#after-a-host-restart)). The calls below are the same
ones by hand, and the only way with `supervisorAutoRepair` off.

Open Docker resources for an employee whose shared pool anchor is unconfirmed
and select **Review stopped pool recovery**. The verified owner can also call
`GET /api/company/employees/:id/docker-pool/cold-preview`. The preview checks the
exact stopped anchor, the approved shared policy, the selected workers and the
original resource writers. It is available when the worker pool is empty and
the prior writers can be accounted for.

Confirm with `POST /api/company/employees/:id/docker-pool/cold-recover` using a
new UUID as `operationId`, the returned `sessionId` and `sessionGeneration`, and
the returned `scopeDigest` as `expectedScopeDigest`. The backend starts the
existing anchor and uses the native helper to apply the previously approved
limits. It commits the new pool observation after fresh kernel readback. The
employee session remains under its original recovery operation.

The backend records the attempt before starting the anchor and records each
helper action before issuing it. If an outcome is uncertain, subsequent effects
stay held under the original operation ID. `retained` reports fresh pool proof.
Use the employee's existing recovery operation to continue its session.

A held attempt is finished with
`POST /api/company/employees/:id/docker-pool/cold-resume` (verified owner, empty
body), which the supervisor also calls. It issues nothing a second time:

- No helper on record and the anchor still stopped: when every native fact and
  the pool metadata are exactly what the attempt was issued for, and the caller
  is the employee it was issued for, its anchor start never took effect and it
  runs now, as itself. When they differ, or a laptop runs, it did nothing that
  lasts and is recorded as ended.
- No helper on record and the anchor running: the start took effect. Its helper
  was never issued and is issued now, once, and the pool is published.
- A helper on record: it is observed under its own cursor. One that was created
  and never started is started with the arguments it was created with, which
  the helper proves again before it writes. One that exited with an error is
  recorded as failed. A completed helper whose pool can be observed publishes
  it; otherwise the attempt is recorded as ended.

An attempt that is recorded as ended confirmed nothing and can write nothing
more. The pool is then read like any other: a stopped anchor can be previewed
again under a new operation, and a running anchor without limits gets them from
the pool step of the next laptop set-up. Only a helper that cannot be proved to
have ended keeps the attempt held. With no held attempt the call answers with
the pool status. An office build that predates this cannot read a journal that
holds an ended attempt; do not return to such a build once one is recorded.

While an employee has no laptop record because a rebuild retired it, the
retired record stands for the pool in these calls: it still names the box's one
anchor, and every native check is made against that anchor as it is now. A full
journal whose attempts have all finished is set aside as
`docker-pool-cold-recovery.jsonl.previous` and a new one is started.
Once format 2 is published, this writer refuses downgrades even if the arrays
later become empty. Older literal-1 readers must refuse the entire store rather
than strip fields. Do not run old/new writers together or restore an older backup
over current company data. This envelope upgrade does not change any employee,
session, binding, approved resource policy, operation or launch fence.

## Reprovision a laptop whose containers are absent

Use this when an employee's recorded Docker containers no longer exist in the
Engine, for example after an operator prune removed stopped containers. The
employee ID, session ID, generation, memories, approved resource policy,
private HOME/Nix directories and provider conversation are kept. Only the
container is replaced. Employees are never recreated or rehired.

The workflow is owner-only: a signed-in, same-origin owner request without
parent-session, worker-identity or service-token headers. No agent permission,
title or CLI reaches it. The GUI has no control for it yet; an authorized
headless client uses the same API.

Preconditions, checked at preview and again at confirmation:

- The employee exists once, is in the office, wants to run, and has no binding
  migration, pending owner stop or open recovery operation.
- One continuation record exists for the current session and generation.
- An Engine listing returns none of: the record's original and destination,
  the employee's bound container, a plan replacement's source container, any
  container labelled `reverie.boxed.employee` for this deployment, and any
  labelled `reverie.employee` for this deployment. A failed or errored Engine
  call is unknown, never absence. If anything exists, running or stopped, the
  request is refused and the ordinary recovery workflows own the laptop.
- No continuation is in flight. No plan move is being dispatched. An open
  native (Docker) plan move for the employee is closed by this operation; any
  other open move is refused.
- The saved session exists. Its boxed view, if any, names one of the absent
  containers. Its launch denial, if any, is a boxed (`docker`) launch with no
  live owner.
- A qualified source image is present: the manifest worker image, otherwise a
  listed source image.
- One per-worker office API network labelled `reverie.boxed.employee` for the
  employee survives with exactly the office attached. This workflow creates no
  network; deployment tooling owns those bridges.

Calls, in order, for employee `EID`:

1. `POST /api/company/employees/EID/docker-absent/preview` with
   `{ "template": TEMPLATE }`. It returns `mode`, `reason`, `sessionId`,
   `sessionGeneration`, `record`, `absent`, `present`, `account`, `home`,
   `nixSource`, `scratchSource`,
   `sourceImageId`, `network`, `networkCandidates`, `planMoves`,
   `templateDigest`, `scopeDigest` and `allowedActions`. It changes nothing.
2. `POST /api/company/employees/EID/docker-absent/reprovision` with
   `{ "operationId": NEW_UUID, "sessionId", "sessionGeneration",
   "expectedScopeDigest": scopeDigest, "template": TEMPLATE }`. It returns
   `{ operationId, state, code?, sourceContainerId?, sourceImageId? }`.
   `ready` means the record is retired and one stopped source laptop exists.
   `held` names the refusing step; send the same body again to resume.
   Before the source is created, the worker image's own networkless
   `reverie-nix-store-prepare` helper additively imports that image's closure
   into the Nix store, as the legacy broker's image preparation did; without
   it the image's tools are dangling links behind the store bind. The first
   call can therefore take a few minutes.
   Every reprovisioned laptop mounts one shared store, `<stateRoot>/nix`
   beside the `employees` directory, instead of a private store beside its
   home. The owner creates that directory once, owned by the laptop user.
   Laptops must not collect garbage in it: each laptop's profile roots live in
   its own home and are invisible to the others. The shared store counts
   against no employee's disk budget.
   A record that requested its destination lists its recorded containers under
   `discard` and still allows `reprovision`: each is removed, never by
   force, only when it is stopped or the Engine shows it hosts nothing beyond
   its own init. A laptop with a live provider is refused; stop it first. Home
   and scratch are binds and are kept.
3. `GET /api/company/employees/EID/docker-policy`. It now reports
   `state: "stopped"`, `operationId: null`, the new `containerId`, `imageId`,
   `destinationImageId`, `policyDigest` and `allowedActions: ["continue"]`.
4. `POST /api/company/employees/EID/docker-continuation` with
   `{ "request": { "operationId": ANOTHER_NEW_UUID, "sessionId",
   "sessionGeneration", "containerId", "imageId", "expectedPolicyDigest":
   policyDigest, "expectedDestinationImageId": destinationImageId,
   "enterOffice": false } }`.
5. `POST /api/company/employees/EID/docker-continuation/observe` with
   `{ "operationId": ANOTHER_NEW_UUID }` until `state` is `ready`. A `held`
   result with `allowedActions` containing `continue` is advanced by repeating
   call 4 with the same body. An unknown outcome is never repeated.

`TEMPLATE` is the owner-approved shared-drive layout:

```json
{
  "user": "1000:1000",
  "scratchRoot": "/HOST/SCRATCH/laptops",
  "mounts": [
    { "source": "/HOST/DRIVE", "destination": "/reverie_workspace", "readOnly": false }
  ],
  "workspaceAlias": true
}
```

`user` is a non-root `uid:gid`. `scratchRoot` must be named `laptops`; the
laptop receives `<scratchRoot>/employees/<employeeId>` as `/scratch` and its
`tmp` child as `/tmp`. Mount targets are limited to `/reverie_workspace`,
`/workspace`, `/projects`, `/projects/<name>` and the read-only operator set
`/host-published`, `/instances/default/tools`,
`/instances/default/console/statusline-exporter.sh` and `/run/reverie-model`.
Paths are absolute and normalized. Targets are disjoint. `workspaceAlias`
mounts the `/reverie_workspace` drive at `/workspace` as well. `network` names
one of `networkCandidates` when the preview reports more than one. The backend
derives HOME from the retired record and Nix from its sibling `nix` directory;
a template cannot name private storage, `/proc`, a worker capsule or an Engine
socket, and no drive may overlap the employee or scratch directories.

Effects of a confirmed request:

- An open native plan move is closed as `failed` with a `dockerAbandonment`
  record naming this operation. Its journal is kept verbatim and is immutable.
- One CompanyStore transaction moves the continuation record and the published
  binding verbatim into `retiredDockerEmployeeContinuations` and removes them
  from the employee. This history is append-only and publishes company format 2.
- The state service removes the saved session's stale boxed view, the holds
  that view carried and its boxed launch denial. A stopped viewer object for
  the session is discarded. Mode, working directory, model, recipe, thread and
  resume fields are unchanged, so the provider resumes the same conversation.
- The create intent is recorded, then one stopped container
  `reverie-boxed-source-<digest>` is created and its ID recorded. It uses the
  inert worker init, no command, the template user, a read-only root, no
  capabilities, `no-new-privileges`, no restart, no device request, no secret
  and no Engine socket. It is never started. The destination is built from it
  by the ordinary continuation, which adds the GPU profile and resource limits.

A lost create reply leaves the operation `held`. Repeating the same request
lists the source by its labels: an existing source is verified and recorded; a
create is issued again only when the Engine positively lists none. A repeated
request after `ready` returns the recorded result without Engine access. A
different operation ID then previews as a source replacement, described below.

### Provider account routing

The backend derives the source's account routing; a request cannot choose it.
The preview reports it as `account`, and it is part of `scopeDigest` and of the
journal entry.

- `generation-env`: a plan replacement still decides where the employee's
  sign-in is. The source carries one variable, `CLAUDE_CONFIG_DIR` (Anthropic)
  or `CODEX_HOME` (OpenAI), set to
  `/home/agent/.reverie/plan-moves/<that record's operationId>/generation-<projectionDigest>/<claude|codex>`
  inside the private home. No mount is added.
- `seat-mount`: the saved session's launch overrides, clamped as the provider
  launch clamps them, set `CLAUDE_CONFIG_DIR` or `CODEX_HOME` to
  `/instances/default/console/accounts/<id>` and `<id>` is the employee's
  current subscription profile. The source receives one read-write bind at that
  exact path. Its host directory is `<home>/.reverie/seat-auth/<id>`, or the
  template's `accountSource` when given; the directory name must be `<id>`. The
  variable is not added to the source, because the launch supplies it. This is
  the only writable path under the accounts root; `mounts` cannot name one.
- `none`: neither applies.

An override that names another profile, two seat overrides, or an
`accountSource` with nothing to route is refused.

Which plan replacement decides is read from the employee's laptop records,
newest first: the record that is being retired or superseded, then each
journal entry from the newest back. A plan replacement record decides, because
its move installed the sign-in in a folder of its own. An entry whose source
was routed as `seat-mount` or `none` decides too: the laptop built from it
left the folder of every earlier plan move, and a later laptop is not sent back
there. An entry whose source only repeats a `generation-env` is skipped and
the record behind it is read instead. The first record of the journal fixes
where the private home is and nothing else; for an employee who has changed
plan since, its folder is one they left.

If the plan that is selected for the employee is on another provider than the
plan replacement that decides, the preview and the request are refused with
`DOCKER_REPROVISION_ACCOUNT_PLAN_MISMATCH` before anything is discarded or
retired. The plan was then changed by something that is not a plan move, and
no record says which folder holds the sign-in. Move the employee to the plan
they should be on, then preview again.

#### The seat folder and its sign-in

The Engine refuses a bind whose host folder does not exist, and an empty seat
would leave the laptop at the provider's sign-in screen. For the default seat
(`<home>/.reverie/seat-auth/<id>`) the workflow therefore runs one fixed helper
from the worker image, as the laptop user, with no network and only the
employee's home writable. It runs before anything is discarded or retired and
again before each attempt to create the source:

- It creates `.reverie`, `seat-auth` and `<id>` with mode 0700 where they are
  missing. A directory that exists must be a real directory of the laptop
  user; a link, another owner or something that is not a directory is refused
  (`DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN`). One of these three whose mode
  is merely too permissive (for example `drwxr-xr-x`) is narrowed to 0700
  through its held handle and read back, and so is an existing sign-in file
  that is not 0600; the receipt lists them as `tightened`. A mode that
  withholds the owner's own access, or a narrowing that does not take, is
  refused. The home itself is never changed: one that is not a private (0700)
  directory of the laptop user is refused (`..._SEAT_HOME_FOREIGN`).
- When the office holds a signed-in copy of that plan account, the helper
  places that copy as the seat's sign-in file (`.credentials.json` for
  Anthropic, `auth.json` for OpenAI). It is the same held account snapshot a
  plan move installs, it reaches the helper on stdin only, and the office
  accepts the result only when the helper reports the digest of exactly those
  bytes. This happens at every rebuild and reprovision, so a token the provider
  rotated at the office does not leave the laptop on a stale copy. A different
  sign-in that was in the seat is kept once beside it as
  `<file>.reverie-previous`.
- When the office is not signed in to the plan, a sign-in file the seat already
  has is left alone and the laptop is built with it.
- When the seat holds no sign-in file and the office is not signed in to the
  plan either, nothing is built: the request is refused with
  `DOCKER_REPROVISION_SEAT_ACCOUNT_SIGNED_OUT` and `seatProfile` names the plan.
  Sign in to it on the Plans page and send the same request again.

A folder named with `accountSource` is the owner's: the office neither creates
it nor writes a sign-in into it. If the Engine reports that a mount's host
folder is missing, the hold is `DOCKER_CONTINUATION_CREATE_BIND_SOURCE_MISSING`
and `missingMountTarget` gives the path of that mount inside the laptop.

#### Rebuilding the laptop of a session this office started

`POST /api/company/employees/:id/docker-rebuild/preview` and `.../apply` also
work while the office process still holds, in memory, the launch it made for
the employee's session. That launch blocks the absent-laptop workflow
(`DOCKER_REPROVISION_LAUNCH_INTENT_FOREIGN`), but not the rebuild, provided it
is owned by the live laptop viewer that the rebuild itself discards and that
viewer is not starting or attaching. The preview then reports
`viewer.ownsLaunch: true` and `requiresConfirmation: true`, and `apply` needs
`confirmDiscardRunning: true` even when the laptop container is already
stopped. A live launch owned by anything else is still refused before any
effect.

The order of effects is: stop and remove the listed containers; stop the
viewer; in one step without an await, release the viewer's launch and forget
the viewer; then the ordinary absent-laptop retirement. A failure before that
step leaves the viewer and its launch together, and one after it leaves
neither, which is the state the absent-laptop workflow handles. In both cases
a fresh preview followed by `apply` completes; the earlier request's
`expectedScopeDigest` no longer matches, because the containers are gone.

### Replace an unused source

The same two calls replace a source that was never started, for example one
created before account routing existed, or one made for an earlier laptop
image. Use a new `operationId`. The preview reports `mode`:

- `replace-source` (`reason: "source-replaced"`): the employee's newest journal
  entry is complete and no continuation record exists.
- `retire` with `reason: "source-superseded"`: one version 2 record was begun
  from that source and never requested a destination (`staged` to
  `pool-ready`, no destination, no binding, no saved boxed view). The record
  moves verbatim into the journal entry.
- `retire` with `reason: "recorded-containers-absent"`: the case above.

For both replacement reasons the Engine must list exactly one container for the
employee: the recorded source, with its recorded name, operation label, image
and network, in state `created` with no start time. Any other container
labelled for the employee, a started source, a later record phase, an open
plan move or a storage holder the journal does not own is refused. The preview
adds `previous: { operationId, sourceContainerId }` and `helpers`.

A storage holder is owned when one of the employee's laptop records lists it,
current or retired. It is also owned when it is listed by the laptop record
that a finished plan move replaced. That record exists in the move's journal
only; a plan replacement that the employee's own journal retired names it by
move, operation and digest, and the move's copy must match all three. Its
laptop was the source of the move, which the Engine listed as absent before
the plan replacement was retired. Any other holder is refused with
`DOCKER_REPROVISION_HELPER_FOREIGN`, and `foreignHelpers` names it. The
rebuild makes this check in its preview, before it discards anything.

A source is created from the laptop image of its day. Once the office runs
another laptop image that does not descend from it, the unused source cannot
be built on: the policy read and a start request answer
`DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED` with the two rebuild calls, and
replacing the source makes one from the current image. The image rule itself
is unchanged, and a laptop that is not that unused source keeps
`DOCKER_CONTINUATION_WORKER_IMAGE_CHANGED`.

Effects: a new journal entry naming the previous operation is recorded first.
Then the old source is removed by ID, without force, and only while the Engine
still reports it never started. Then the new source is created as above. A lost
removal reply is settled by listing: an absent source is recorded as removed, a
present one is re-proven unused before removal is requested again.

A superseded record's storage holder (`reverie-boxed-storage-<digest>`,
labels `reverie.box.storage.*`) and exited ephemeral helpers
(`reverie-boxed-ephemeral-<digest>`, labels `reverie.box.ephemeral.*`) are left
in place by this workflow. The exited helpers are removed later by the owner's
[leftover cleanup](#remove-superseded-laptop-leftovers). No workflow stops a
storage holder, so this one does not either. A holder keeps read-only directory handles and its name belongs to the
retired operation, so the next continuation creates its own. The shared pool
anchor and pool helpers are not touched; their lineage stays in
`dockerSharedPoolLineages`.

This workflow never starts a container, launches a provider, edits a resource
policy, creates a network, deletes journal history, or changes an employee's
identity, session, generation or account. It removes only a never-started
reprovision source. Rebuilding deleted worker images is separate. Installed
qualification on a real Engine is still required.

## Remove superseded laptop leftovers

Every laptop set-up leaves three stopped one-shot helpers behind, and every
laptop image the office has run stays on the host while one of them exists,
because Docker does not delete an image a container was created from. This
operation removes the helpers of laptop generations the office has retired,
and then the laptop images nothing refers to any more. It is the only supported
way to do that; do not prune containers or images by hand, because the office
reads several stopped containers again (below).

Both calls are owner-only: a signed-in owner request without parent-session,
worker-identity or service-token headers, and the second one same-origin. No
agent permission or title reaches them. There is no GUI control yet; an
authorized headless client uses the same API.

`GET /api/company/docker-resources/leftovers` reads only. It lists the
Engine's complete container inventory twice (the two listings must agree),
classifies every container, and returns:

- `containers.remove`: the helpers one apply removes, at most 48, each with its
  kind, employee and operation. `containers.deferred` counts further superseded
  helpers that a later report will offer.
- `containers.kept` and `containers.keptByReason`: everything else, with the
  reason it stays.
- `images.remove` (at most 8) and `images.kept`, for images tagged
  `reverie-boxed-worker:*` or `reverie-boxed-source:*` only. Other images are
  not listed.
- `sourceImageIds`: which entries of the runtime configuration's approved
  source list are `unneeded` (no laptop record, binding, waiting source or
  remaining container uses that image), which are `absent` from the host, and
  which are `needed` and why. The list is capped at 32 entries and is produced
  outside the office, so this is a report for the next build: drop the
  `unneeded` entries there. The office does not edit its own configuration.
- `docker`: the image and container lines of `docker system df` as Docker
  printed them, with the same figures in bytes. `reclaimableImageBytes` is the
  sum of the bytes Docker attributes to the listed images alone. Laptop images
  share most of their layers, so this is usually far less than their nominal
  size: layers shared only among the removed images are freed on top of it, and
  layers shared with an image that stays are not freed.
- `digest`, which binds exactly the removals listed, and `allowedActions`.

`POST /api/company/docker-resources/leftovers/apply` with
`{ "expectedDigest": "<digest>" }` computes the report again and refuses with
`DOCKER_LEFTOVER_SCOPE_CHANGED` unless it is the one the owner saw. It then
removes the listed helpers one at a time, and after them the listed images. It
answers `state: "complete"`, or `state: "incomplete"` with a `code` and the
list of what was removed before it stopped. Repeat from a fresh report; each
step only removes, so repeating converges.

### What counts as superseded

A helper is removed only when all of this holds:

- A laptop record in `retiredDockerEmployeeContinuations` names that exact
  container. The office writes such an entry only after the Engine positively
  listed the laptop of that record absent. The record names its
  ephemeral-directory helper (`reverie-boxed-ephemeral-<digest>`), its identity
  installer (`reverie-boxed-identity-<digest>`) and its leaf writer
  (`reverie-boxed-leaf-helper-<digest>`).
- The container's name, image and labels are the ones that record and this
  box give it, and its state is `exited`.
- No current laptop record, employee binding, pool record or unfinished cursor
  names the container or its operation.
- The employee has nothing in flight: no laptop operation or reprovision in
  this office process, no reprovision whose source is not created yet, and no
  open plan move. Without the plan journal nothing is removed.
- For an identity installer: the installer of the employee's current record is
  still listed. The office treats "no installer of this employee exists" as a
  fact of its own, so the others stay until that one is back.
- For a leaf writer: the laptop it wrote to is neither listed nor recorded.

Kept, always, with these reasons:

| Reason | What it covers |
| --- | --- |
| `storage-holder` | Every `reverie-boxed-storage-*` container, current or superseded. A holder keeps read-only handles on an employee's home and Nix store, and the office reads the log of a stopped one again. |
| `shared-pool` | The pool anchor and pool writers. Pool reconciliation reads their logs again. |
| `laptop` | Laptops and their never-started sources, running or not. Only the laptop rebuild removes one. |
| `current-operation` | A helper that a laptop on record still names. The office reads its exit state and log again, and can start an ephemeral helper again. |
| `operation-in-flight` | See above; `detail` says which. |
| `not-terminal` | Created, running, paused, restarting or dead. |
| `unrecorded`, `record-mismatch` | A boxed helper no retired record names, or one that differs from its record. |
| `installer-inventory`, `worker-present` | The two special rules above. |
| `unclassified` | A boxed name with no rule here, for example a seat or Nix preparation helper. |
| `foreign` | Anything else on the host, including another box's helpers and the office's own deployment containers. |

Volumes and networks are never touched, nothing is stopped, and no removal is
forced: a helper that is running again is refused, and it is left as it is.

An image is removed only when it carries nothing but laptop image tags, is not
the configured laptop image or a helper image, is named by no current record,
binding or waiting source, has no remaining container, and is named by a
retired laptop record. That last condition keeps an image that was built for
the next update and has not run a laptop yet (`never-recorded`). The Engine
port removes the image's tags without force, so the Engine itself refuses the
last one if a container still uses the image. Rebuilding a removed laptop
image is a build, as before.

Removing a leaf writer changes the box-wide listing of leaf writers. A resource
observation of another employee that runs at that same moment can be refused
once (`DOCKER_RESOURCE_LEAF_CENSUS_CHANGED`) and succeeds when repeated.

Current gaps: superseded storage holders keep running; the deployment tool's
own stopped containers (`reverie-before-front-*`, `reverie-candidate-*`) and
the office images they pin are outside this operation and outside
`prune-deployments`; the retired-record journal itself is append-only and
capped at 256 entries; and there is no GUI control.
