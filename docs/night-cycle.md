# Night cycle: consolidation and dreams on the local GPU

`fleet-cycle` can run **nights only**: no planning and no day work, only each persistent agent's
consolidation (reflection over its episodes), one dream and sleep. Agents go one at a time on the
local model, and only while the GPU is idle. A host timer runs one `tick` every 5 minutes, and each
tick starts at most one model phase.

## Policy (instance data, outside the repository)
Night-only mode is on when the coordinator's `waking` and `planning` caps are 0 and no task is
approved. In that mode the cycle never opens the coordinator's store before the night, so a hold
or a broken store on the coordinator blocks no one else.

| Field | Meaning |
|---|---|
| `night` | `{"start": "HH:MM", "end": "HH:MM"}` in `timezone`, which is then required. It may wrap past midnight: in 23:00-05:00, a 02:00 tick belongs to the previous date's night. A tick outside the window returns before any network, controller lock or memory store access. Constructing the cycle still creates the state dir and its ledger and reads each instance config. |
| `night_order` | The agent order (default: policy order). It rotates by one each night, so a shared ceiling never starves the same agent. |
| agent `night_start` | Optional `HH:MM` inside the window. That agent sleeps only once the night reaches it. |
| agent `live_resource` | The resource a live runtime of this agent uses (for example the local GPU). Its store's `fleet_last_activity` feeds the GPU gate. |
| `gpu_gate.min_idle_seconds` | Default 1800. Required with a night window on a local model. |
| `backup_dir`, `backup_keep` | Required with a night window. Keep defaults to 7. |
| `episode_chars`, `max_batches` | Each episode is clipped to `episode_chars` (default 2000) in reflection prompts. Consolidation runs at most `max_batches` (default 10) batches, each at most half the model's context. |

A night is the local date its window started. Phases are idempotent per night in the ledger, so a
repeated hour at the end of daylight saving time never runs a night twice, and a skipped hour skips
nothing. A changed window takes effect from the next night.

## What one agent's night does
1. **Lock.** Take the agent's `<data_dir>/maintenance.lock` without waiting, the same lock the
   bridge's `maintenance` uses. If it is held, the agent waits for a later tick.
2. **Backup**, once per night, before any write:
   - a copy of `profile.md` and an online SQLite copy of the store, both as `.tmp` files
   - `PRAGMA quick_check` on the copy; a failed check removes both temporaries and defers the agent, leaving nothing published
   - fsync, rename the profile, then rename `<night>.sqlite` **last** (its presence means the backup is complete), then fsync the directory
   - the directory is 0700 and the files 0600
   - retention keeps the newest `backup_keep` nights and removes older ones, orphaned profiles and stale temporaries
3. **Consolidation:**
   - It runs in batches that fit the model's context. A huge episode is clipped and can never block every batch.
   - Before each later batch, the cycle checks the GPU gate again and the pause files. A stop after the first batch leaves the rest pending for the next night.
   - Each batch's insights commit together with the reflection cursor (`MemoryStore.atomic()`). That covers the store's own reflection, belief and state writes. It has no savepoints, so a nested block's error must not be caught and ignored, and writes through `Fleet` documents are separate transactions.
   - An insight that echoes a credential (`cto/secret_scan.py`) is not stored.
4. **One dream**, only when `REVERIE_DREAMS_PER_SLEEP` is above 0 (the default is 0).
   Set `REVERIE_DREAMS_PER_SLEEP=1` to enable it, and enable `dreaming` on an expert
   profile when using an expert. The cycle's agent policy entry can veto dreams with
   `dreaming: false`; even `dreaming: true` does not override a global zero quota.
   Disabled scheduled dreams record `skipped` with detail `dreams disabled`, without
   a model call or usage reservation. An explicit owner-requested `cto-chat --dream`
   remains separate and can run once with background dreaming disabled.
   A dream is not stored if it echoes a credential.
5. **Sleep.**

**The GPU gate** runs before every model phase. If any of these holds, the phase is deferred and retried next tick:
- a `live_resource` runtime was active recently
- the shared GPU lock is held, in any role
- a chat or review used the GPU recently
- a hold file or a busy review session is present
- the model server lists **any other model** in a state other than `unloaded`
- the loaded model's `/slots` shows a request in progress

The gate only reads `/slots` for a model that is already loaded, so it never makes a router load one. If a check cannot be made, the phase is deferred (it fails closed). The lock probe is a shared, non-blocking `flock` that never creates the file. A missing lock file means no tenant ever used it; any other error defers.

Known residual: during one long agentic turn, `fleet_last_activity` changes only at its start and end, and `/slots` is idle between generations. So after 30 minutes one batch can overlap that turn. The late window makes this unlikely. The host's `gpu-idle-check` adds what only the host can see: GPU utilisation, other GPU processes, and `~/.config/reverie/gpu.hold`.

## Install (host)
1. Write the policy inside the container's instance data (for example
   `/instances/<instance>/runtime/cycle/cycle-policy.json`) and check it with
   `fleet-cycle --policy … status`. That first `status` creates the state dir and the ledger.
2. Set up the host files:
   ```
   install -m 0755 scripts/gpu-idle-check ~/.local/libexec/reverie/gpu-idle-check
   printf 'REVERIE_CYCLE_POLICY=/instances/<instance>/runtime/cycle/cycle-policy.json\n' > ~/.config/reverie/cycle.env
   cp systemd/reverie-cycle.{service,timer} ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemd-analyze --user verify ~/.config/systemd/user/reverie-cycle.service
   ```
3. Test both paths. **The idle case must be run with the model loaded and idle**: some drivers name the router process `[Not Found]`, which blocks every tick until `GPU_IDLE_ALLOW_UNNAMED=1` is set in the unit's environment:
   - `~/.local/libexec/reverie/gpu-idle-check; echo $?` while idle (0)
   - the same while the GPU is busy, or after `touch ~/.config/reverie/gpu.hold` (1)
4. `systemctl --user enable --now reverie-cycle.timer`.

## Operating
- **Stop:** `fleet-cycle --policy … pause`. It takes effect at the next phase or batch boundary; `resume` undoes it.
  - `systemctl --user stop` only ends the podman client of a running tick.
  - `disable --now reverie-cycle.timer` prevents new ticks.
- **Pause one agent:** `touch <its data_dir>/maintenance.hold`.
- **Mark the GPU as taken** (a demo, training): `touch ~/.config/reverie/gpu.hold` on the host.
- **Morning check:** `fleet-cycle --policy … status --night` reports the current or last night. It exits 1 if a night phase needs review or has been running for over an hour.
- **A failed or interrupted phase** blocks that agent until the next night. After inspecting the
  ledger and the agent's state:
  `fleet-cycle --policy … clear-phase AGENT PHASE --day NIGHT --reason "…"`. This is logged to
  `<state_dir>/clear-phase.log`, and the next tick reruns that phase.

## Restoring an agent's store from a night backup
Run every file step **inside the container as `cto`** (`fleet-container engine exec --user cto reverie-live …`), so the restored files keep the right owner.
Live writers keep writing while the cycle is paused: the OpenCode plugin's `record` and `activity`,
and `fleet-memory remember`. Restoring under them can corrupt the store or lose writes. So:
1. Stop the writers:
   - `touch <data_dir>/maintenance.hold`
   - `fleet-cycle … pause`
   - stop the agent's live runtime (the host or Codeman closes its session)
2. Keep the current store as evidence:
   `cp -p memory.sqlite memory.sqlite-wal memory.sqlite-shm profile.md <somewhere 0700>/` (whichever exist).
3. Remove `memory.sqlite-wal` and `memory.sqlite-shm`. A stale WAL beside a restored file corrupts it.
4. Restore and check:
   ```
   install -m 0600 <backup_dir>/<agent>/<night>.sqlite memory.sqlite
   python3 -c "import sqlite3; print(sqlite3.connect('memory.sqlite').execute('PRAGMA quick_check').fetchone()[0])"
   ```
   Then restore `profile.md` from `<night>.profile.md` with mode 0600.
5. **Writes made after the backup are lost:** turns recorded during that day, and the night's
   reflections and dream. If they matter, re-record them from the evidence copy by hand.
6. If that night should run again, `clear-phase` its phases. Then remove the hold, `resume`, and
   restart the runtime.

Backups hold the same private data as the stores. Keep them on this machine; do not sync the
backup directory anywhere.
