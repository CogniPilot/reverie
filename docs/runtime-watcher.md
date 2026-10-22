# Agent runtime watcher: keep-alive and binding restore

`reverie-runtime --policy POLICY watch` supervises the one persistent agent runtime named
by the external policy. It never manages other agents, so intentionally stopped
workers stay stopped. Each tick re-reads the controller state under a file lock.

## Decision table (one tick)

| Observation | Action |
|---|---|
| owner pause file exists | `paused`; no API calls |
| creation uncertain, or candidate pending and alive | `pending`; never create another |
| pending candidate gone or exited | `candidate_failed`, alert, no new session |
| phase is `owner_closed`, `clean_exit`, `missing_needs_owner`, `needs_owner` or `candidate_failed` | stay stopped until `activate` or the owner resets the state |
| live, no pane exit | healthy or `needs_attention` (dialog, no pid); refresh name, working dir, `last_seen_at` and room/company binding snapshot (at most every `binding_refresh_seconds`, default 300) |
| pane exit `status: 0` and no signal | `clean_exit`; no respawn |
| pane exit with a signal, a non-zero status or **no status** (a SIGKILL/OOM on tmux 3.2a reports none) | recover |
| session 404 and newest decisive lifecycle event is `deleted` (owner X, guarded CLI, clean-exit sweep) | `owner_closed`; no respawn |
| session 404 and newest event **after `last_seen_at`** is `mux_died`/`stale_cleaned` (container or tmux restart) | recover, reason `container_restart` |
| session 404 with no such event, or never seen alive | `missing_needs_owner`; no guess |

Lifecycle events come newest-first from Reverie (it reads its log backwards). The
watcher both asks for `since=last_seen_at` and filters on the client side, so an
older restart event can never count.

Recovery is bounded by `max_recoveries` per 15 minutes (then sticky `needs_owner`) and
checks local keep-alive and memory admission first. Before creating anything, it
looks for live sessions that already carry the identity: a non-empty name equal to the
recorded current name or `CTO · <backend>`, the recorded working dir (or a dir named
after `case_name` for older state), and not the dead runtime, the `previous` runtime
or any earlier candidate. A sole match is adopted only if it runs the dead runtime's adapter, was created after
`last_seen_at`, maps to a policy backend, and is not the watcher's own session. A shared
working dir is not identity: the coordinator may share the supervised agent's directory. A match that
fails these checks stops with `needs_owner`, because creating another session would
duplicate the identity. More than one match
stops with `needs_owner`. A candidate that dies before activation gives
`candidate_failed`. If a planned switch's candidate dies while `current` is still live, the watcher
alerts and keeps supervising `current`. These stops raise an alert. Reverie posts as the
user when a parent session does not resolve. So before posting to `alert_room`, the
watcher checks that its own `REVERIE_SESSION_ID` is live, is a member of that room, and
is not a supervised runtime. It sends `requireAgent: true` (a patched console refuses;
today's strict schema rejects the unknown field) and checks that the returned sender is
itself. Undelivered or misattributed alerts are kept in `undelivered_alerts`.
`reverie-runtime reset` (owner) leaves a stopped phase. It refuses while a creation is
uncertain unless `--creation-inspected` is passed. It also refuses while a candidate
is still live, so it can never orphan one and leave two runtimes for the same agent, and it keeps the
recovery-attempt history, so a reset cannot buy extra respawns inside the 15-minute
window. The persisted-before-create
`creation_uncertain` guard is unchanged. The recovery handoff tells the replacement
not to accept dialogs or rerun interrupted/uncertain jobs. The watcher never sends
input to a pane.

## Binding restore

Healthy ticks record the rooms (with role, from either `role` or `coordinatorId`) and
the company employees bound to the current session. `activate` reads the replaced
runtime's bindings live, merges them with that snapshot and freezes the result as
`restore_source` before switching. Healthy ticks never overwrite it. The restore then
re-reads the actual holders. A room is rejoined only if the replaced session is still
a member; if the owner removed it, the room is skipped. An employee is rebound only
if it is still bound to the replaced session or to nobody; if it now belongs to
another session, that becomes an owner action. Coordinator roles, and 401/403
refusals, are always owner actions; caller identity is never stripped. A transport
or 5xx error is returned from `activate` with a `restore-bindings ID` retry, and
`restore_source` stays until a restore finishes with no owner actions left. A
missing snapshot is reported, not silent. Old sessions are never deleted
automatically.

## Supervision (design; templates in `systemd/`, not installed)

A watcher started manually in a shell session is lost when the container restarts.
Use the reviewed user-service templates to supervise it independently of that session:

1. **Start with the container.** A host user unit, `reverie-watcher.service`, runs
   `reverie-container engine exec --user agent reverie-live reverie-runtime --policy ... watch`. It is
   `BindsTo=`/`WantedBy=reverie.service`, so it stops and starts with the console and
   needs no image or entrypoint change. `Restart=on-failure` handles a crash, and
   `systemctl --user stop reverie-watcher` is the intentional stop. Stopping the unit only
   kills the podman client, so `ExecStopPost` runs `reverie-runtime stop-watcher`. That
   sends SIGTERM, then SIGKILL after 5 s, to every `reverie-runtime ... watch` process for
   this policy (the active one and any standby), so watchers never pile up under the
   memory cap. The watcher runs explicitly as `agent`, with the container env (no
   `REVERIE_SESSION_ID`).
2. **Never two active watchers.** `watch` holds an exclusive `state.watch.lock` for its
   whole lifetime. A second instance prints `standby` and blocks until the lock frees,
   then takes over (hot standby). Per-tick state changes still use `state.lock`.
3. **Notice a dead, hung or failing watcher.** Each tick runs under `SIGALRM`
   (`keep_alive.tick_timeout_seconds`, default 300) with the default action. A tick
   hung anywhere, even in C, ends the process, which frees the lock, and systemd
   restarts it. The policy is re-read inside each tick, so a broken policy is a failed
   tick, not a crash loop. Every tick writes `state.heartbeat` (pid, consecutive errors,
   last success, last error). `watcher-health` reports **ticking** (heartbeat newer than
   `3 x poll + 30 s`) separately from **healthy** (ticking, and the last tick
   succeeded). It exits 1 when not ticking, or not healthy with `--healthy`. `status`
   includes both. The 5-minute `reverie-watcher-check.timer` uses `try-restart` only
   when the watcher is not ticking. A ticking watcher with failing ticks is reported,
   not restarted, because a restart cannot fix Reverie being down.
4. **Alerts.** A host-run watcher has no Reverie identity, so alerts go to
   `undelivered_alerts` and the host journal (`journalctl --user -u reverie-watcher`).
   They are never posted as the user. Optional: once the console post-only patch is
   deployed, the user adds a dedicated shell session as a **post-only** member of
   `alert_room`, and the unit passes its id (`--env REVERIE_SESSION_ID=...`). That
   identity is gone after a container restart until it is recreated, and alerts fall
   back to the state.

Migration order (owner): deploy the reviewed code, identify and stop any existing
manual watcher that does not take `watch.lock`, install and enable the units, then confirm
`reverie-runtime status` shows `watcher.alive: true`.

## Shell members never receive room text (console patch, `apps/console`)

Reverie delivers room messages by typing them plus Enter into each member's pane, so a
shell member would run them as commands. `ChatroomDelivery.flush()`, the only writer,
now types only into modes marked as chat-capable in an exhaustive
`Record<SessionMode, boolean>`. Shell and unknown modes have their queue dropped. This
also covers legacy members. `ChatroomService.assertJoinable` refuses a non-agent session
on every join path (create, add, appoint, company invite/spawn) unless the **user** adds
it with `postOnly: true`. Room creation checks every member before the room exists, so a
refusal leaves nothing half-made. A post-only member gets no briefing and no messages,
cannot coordinate or be the voice, and can still post as itself.

## OpenCode reply guard and its relay log

When an OpenCode turn that received a room delivery ends without posting to that room,
the plugin does not relay the leftover text. It appends `{at, session, rooms, text}` to
`.reverie-relay-log.jsonl` in the agent's directory (mode 0600). Setting
`reply_guard: "post"` restores the old relay. A short room id in the reply counts as
the delivered room when it is a prefix of the full id.

**Retention: the relay log keeps text for the owner-configured period (7 days
in this example).** The nightly
sleep step prunes it through a `prune` entry in the sleep policy:
`{"path": "<agent dir>/.reverie-relay-log.jsonl", "days": 7, "live": true}`. It goes by
each line's own `at` stamp, never by file mtime. It drops lines older than the retention,
and also any line without a readable stamp, since that may still hold DM text. A
trailing line with no newline may be mid-append, so it is kept for one night and dropped
if it is unchanged the next night. The file is rewritten at 0600 through a temp file and
a rename. Without `"live": true` an entry only reports `would_prune N`. The global
`dry_run` does not affect pruning; lifting it would also turn on memory consolidation,
model maintenance and morning notes.

## Memory-aware admission

`python/reverie/admission.py` refuses new work when `used + expected > limit - reserve`. Here
`used` is the cgroup's `memory.current` minus reclaimable `inactive_file`, and the
default reserve is 512 MiB. An unlimited or unreadable cgroup is admitted. `start()`
(switch, reboot, recovery) checks the backend's session cost first. A refused
recovery returns `blocked` without spending a recovery attempt, so an OOM-killed
runtime is not replaced straight into the same OOM. Conservative default session
costs are budgeted as claude/codex 400 MiB and opencode 1100 MiB. Measure the
intended deployment before choosing overrides. The policy may override them with
`memory_admission.{reserve_bytes,session_cost_bytes}`. Heavy commands use the same
gate: `python3 -m reverie.admission --expect 1.5G -- npm test` exits 75 when refused.

Console tests: a root `apps/console/vitest.config.ts` makes a bare `npx vitest run`
use the CI config (and therefore `test/setup.ts`). `test/setup.ts` throws when
`REVERIE_DATA_DIR` holds a live `state.json`.

## Agent profile (read-only)

`reverie-runtime --policy POLICY profile SESSION_ID` prints one agent session's profile as JSON for
the console's profile panel (`GET /api/agents/:id/profile`, `apps/console`):
- backend, model, and effort: the console's spawn default, plus the level the newest Claude Code
  transcript turn used
- the console's usage counters
- the company employee and rooms it is bound to
- whether this controller supervises it, with the configured backends
- the owner-selected persona

The persona comes from the supervised runtime's own `.reverie-instance`, or else from the policy's
optional `agent_instances` map (session id to instance config). A shared working dir is not
identity, so the marker counts only for the tracked session. Every agent runs as the same user that
owns the marker and the policy, so neither is trusted: the config a marker or a map entry names is
resolved (symlinks and `..` included) and must lie strictly inside the policy's `instances_dir`.
Without `instances_dir` no persona is shown. A relative marker path resolves against the working
dir, and a relative map entry against the policy's directory. An unreadable config is reported only
as "instance config unreadable". A map entry is keyed by console session id, so a relaunch under a
new id needs its entry updated.

All agent-writable inputs are read defensively: the marker, the transcript and the instance config
must be regular files, opened without following a final symlink and without blocking. The marker is
refused above 4 KiB and the instance config above 64 KiB; only the transcript's last 512 KiB is
read. The effort must be a known level (low, medium, high, xhigh, max), and its timestamp a string
of at most 64 characters.

`--no-dms` leaves out direct-message rooms; the console passes it for an agent caller.

It makes GET calls and local reads only, and it never takes the watcher's lock. Backend
switching is listed as unavailable: it is an owner action and waits for owner authentication. An
unknown session prints `{"error": "no such session", "status": 404}` and exits 1.

## Not done here (needs owner approval / deployment)

- Running the watcher requires an owner-configured supervisor, `keep_alive` policy
  and adequate container memory limits. Review these before enabling the service;
  source installation alone does not activate supervision.
- A SIGKILL can leave no `exit` lifecycle event; the watcher depends on `paneExit`
  for live crashes.

See [runtime configuration](runtime-configuration.md) for neutral model defaults, profile section keys, and required user-service environment files.
