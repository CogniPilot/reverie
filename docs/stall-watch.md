# Stall watchdog for the local OpenCode agent

The runtime watcher (`docs/runtime-watcher.md`) restarts an agent that **crashed**. The stall watchdog
(`python/reverie/stall_watch.py`) handles one that is **alive but stuck**:
- It never restarts anything and never starts a new session or thread.
- It types at most `max_nudges` lines per `nudge_window_minutes`.
- It **fails safe**: when in doubt it does nothing, or only reports.

## What it detects
| Condition | Evidence | Response |
|---|---|---|
| Busy, no progress | The console says busy, and for `busy_stall_minutes` (6) there is no new assistant output in OpenCode's database and no change in the pane's transcript (timers and spinners don't count). | escalate |
| A long silent tool | A tool call in the running turn is `running` or `pending`. Tools write nothing until they end, so this is alive. Only after `tool_stall_minutes` (30) is it reported. | report only |
| Slow reasoning | A reasoning stream in the running turn is still open after `busy_stall_minutes`. | report only |
| Unanswered input | Idle. The newest input (the console's last submit, or the database's last user message) is newer than the last answer by `idle_unanswered_minutes` (4). | escalate |
| Step limit (best effort) | The newest message carries OpenCode's "CRITICAL - MAXIMUM STEPS REACHED / … Tools are disabled until next user input." notice (whitespace collapsed), and no input followed it for `max_steps_grace_minutes`. OpenCode adds that notice only to the model request, so it appears in the database only when the reply echoes it, which it often does. The phrase elsewhere in a text never counts. An unechoed stop shows up as an unanswered input instead. | escalate |
| Pane dialog | The console reports a `paneDialog` for `dialog_minutes`. The report names no dialog text. | report only |
| Stuck delivery queue | Room deliveries stay queued (`pendingDeliveries`) while idle. | report only |
| **Shell mode** | The prompt's status row reads `Shell`, or the hint row offers `esc exit shell mode`. | Esc |
| **Deliveries eaten by shell mode** | The database holds a bash call "executed by the user" whose command is a room delivery (`[Reverie chat "…"] …`). | re-read note |

## Why deliveries get eaten (root cause, for the console)
OpenCode switches its prompt to shell mode when a `!` is **typed**, anywhere in the line. The `!` is
swallowed, Enter runs the line as bash, and the prompt stays in shell mode until Esc. The console
types room messages (`tmux send-keys -l`), so a message containing `!` is lost, and so is every
delivery after it until someone presses Esc.

The fix belongs in the console's delivery path: a bracketed paste (`tmux load-buffer` +
`paste-buffer -p`), or a replaced `!`. The watchdog only limits the damage.

## What it does
**Escalation**, per episode, with `step_wait_minutes` (3) between steps:
1. **Nudge:** paste `continue` and press Enter.
2. **Interrupt and resume:**
   - Esc twice (OpenCode needs two presses within 5 s).
   - Then paste a fixed neutral note: "Your turn stopped making progress, so it was interrupted. Resume the task you were on; if you need the context, re-read your rooms."
   - It **never resends** a room message, a recovery handoff, a dream prompt or any other earlier input.
3. **Report** `needs_attention` once, as a coded report the host turns into a notice (see Reports).

**Shell mode:** Esc, but only when idle (one Esc mid-turn would arm an interrupt), then a check on the
pane that the prompt is back to normal. It then pastes one note naming the rooms whose messages ran as
bash, each with its `reverie agent chat read --room '<room>'` command (shell-quoted). Leaving shell
mode is not counted as a nudge; it is limited to once a minute, and reported if two attempts fail.

**When an episode ends:** only when the agent produces new assistant output, or after 2 hours. Its own
typing never resets the escalation.

**Typing:** always a bracketed paste, never typed keys, and never into a prompt in shell mode.

## When it does not act
Checked every tick, before any action:
1. **Blind, so nothing at all happens** (not even a report; logged once when it starts):
   - the OpenCode database cannot be read (missing, locked, corrupt)
   - no thread is found
   - the pane cannot be captured, or shows no OpenCode prompt
   - the console's thread is not the newest top-level thread in the agent's directory (`thread_mismatch`; the agent moved on)
2. **Holding for the runtime watcher, so nothing at all happens.** It reads the watcher's state (`runtime_policy` → `state_file`) and holds while:
   - there is a candidate
   - the last creation is uncertain
   - a recovery happened within `recovery_quiet_minutes` (10)
   - the watcher holds its per-command lock (`controller-state.lock`) right now
   - its policy or state cannot be read

   The lock is read from `/proc/locks` and **never taken**. A probe lock, even a shared one, could make the watcher's own non-blocking take fail.
3. **Report-only, never typing or pressing Esc:**
   - **the night window:** the cycle policy's `night` and `timezone` (`cycle_policy`), else this config's `night`
   - **the shared GPU lock** held by a non-chat role (a dream, training, a review). Like the watcher's lock, it is read from `/proc/locks`, never taken, and its role comes from the holder's JSON in the lock file.
   - **a hold file:** `hold_files`, by default `~/.config/reverie/gpu.hold` and `~/.cache/reverie.hold`
   - **the owner's runtime pause file** (the runtime policy's `pause_file`)
   - the watchdog's own `pause_file` stops it entirely
4. **Write-ahead:** the nudge count and the episode step are saved **before** an action. If that save fails, nothing is done, so a full or broken disk cannot lift the cap.
5. **A tick never outlives its minute** (`tick_seconds`): it ends itself rather than act late. Stopping the systemd unit only ends the podman client. The deadline is held off between a paste and its Enter, so no half-sent line is left in the prompt for the next delivery to join.

## What it reads
- **Console API:** `GET /api/v1/sessions` (the target is the one **live** OpenCode session with that name; a stopped namesake is ignored) and `GET /api/chatrooms`. Report posts go to `POST /api/chatrooms/:id/messages`.
- **The OpenCode database**, read-only: only timing, part types and statuses from `session`, `message` and `part`. No message text is kept or logged. It never reads the account or credential tables.
- **The pane:** `tmux -L <socket> capture-pane`, last 60 lines.
- **Read-only state:** the runtime watcher's state and policy, the cycle policy, the GPU lock and the hold files.

## Reports
Reports are **room notices**, posted to the console's service-only route
`POST /api/chatrooms/:id/notices`. They are shown as `system` under the service's name (for example
`stall-watch (service)`) and delivered to the listed members.

**Nothing in the container is trusted with words or with the token.** Inside the container everything
runs as the agents' uid: the installed code, this config, the tick's stdout pipe. An agent could change
any of them, so the work is split:
- **The in-container tick** never posts, never holds the token, and prints no text for a notice. For a
  report it prints one **coded** line:
  `stall-watch-report v1 <kind> <n> <started> <tried mask> <quiet mask>`
  - `kind`: one of the fixed condition words
  - `n`: minutes or a count
  - `started`: the episode's start, epoch seconds
  - the masks: what was tried, and why nudging was off

  A dry run prints none.
- **`scripts/stall-watch-host`, on the host,** is the only holder of the token and the only author of
  the notice. It:
  - fetches the two console reads (sessions, chat rooms) with the token and feeds them to the tick on
    stdin (`--console-json -`), so the tick also works under `enforce`
  - reads at most one report line and validates every field: `kind` against the fixed list, bounded
    integers without leading zeros, bounded masks, a start time within the last two days. Anything
    else, including old-format or unknown `stall-watch-*` lines, is refused.
  - writes the text from its **own templates**
  - takes the agent's name (`STALL_WATCH_TARGET_NAME`) and the rooms and recipients
    (`STALL_WATCH_REPORTS`) from **host** config only
  - posts at most once per room per `STALL_WATCH_MIN_INTERVAL` (30 min by default), and at most
    `STALL_WATCH_DAILY_CAP` notices per room per 24 h (8 by default)
  - writes other tick output to the journal marked `tick: `, without control characters, cut at 500
    characters and at most 20 lines per run, so container text never reads as its own
  - never posts when the unit runs `--dry-run`
  - passes the token to curl through a process substitution, never on a command line

**At worst,** a forger in the container can trigger a correctly worded "needs attention" notice, once
per room per interval and at most the daily cap per room.

**The tick runs only the installed package:** the unit uses `podman exec --workdir /` and
`python3 -I -m`. The container's default working directory is the agent-editable work tree, and
`python -m` would import `reverie` from there.

**Old configs:** `report_as` is gone. A config that still sets it is refused with a clear message;
`report_as: null` is accepted. `report_rooms` is ignored: the rooms are host config now.

## Files
- **Config** (instance data, outside the repo; example in `examples/stall-watch.json`):
  - `target.name` (or `target.session_id`)
  - `state_file`, `log_file`, `pause_file`
  - `runtime_policy`, `cycle_policy` or `night`
  - `gpu_lock`, `hold_files`
  - the thresholds above (the report rooms, recipients and name are host config)
- **Log:** JSONL, mode 0600, rotated at 1 MiB to `.1`.
  - One line per new condition, per action, and per change in standing down.
  - Repeated errors are logged once until they change.
- **State:** JSON, mode 0600. A dry run keeps its own `*.dry.json` state.
- **First run, or a new target session:** only deliveries eaten in the last 15 minutes get a note.

## Install (host, owner-run)
1. Copy `examples/stall-watch.json` to `/instances/<instance>/runtime/stall-watch.json` and fill it in.
2. Install `scripts/stall-watch-host` to `~/.local/libexec/reverie/` and `systemd/reverie-stall-watch.{service,timer}`. **The service runs `--dry-run` by default.** Its `ExecCondition` checks for the config **inside the container** (a `Condition…=` would look on the host, where the instance path does not exist), so a missing config skips the tick quietly.
3. Run `systemctl --user daemon-reload && systemctl --user enable --now reverie-stall-watch.timer`. Confirm the ticks run (`systemctl --user list-timers`, and the service status has no failed condition), then read the log through at least one long tool call and one night.
4. **To let it act:** `systemctl --user edit reverie-stall-watch.service`, then add:
   ```
   [Service]
   Environment=STALL_WATCH_FLAGS=
   ```
   Remove the drop-in to go back to dry-run.
5. **Pause:** create the `pause_file`. **Stop:** `systemctl --user disable --now reverie-stall-watch.timer`.
6. **Service token, rooms and name (host only):**
   - Run `reverie owner service-token issue stall-watch` from a host shell.
   - Write `~/.config/reverie/stall-watch.env` (mode 0600, on the host) with:
     - `REVERIE_SERVICE_TOKEN=…`
     - `STALL_WATCH_REPORTS="<room id>=<to>[,<to>] …"`, for example `"<lounge>=<reverie name> <platform room>=coordinator"`
     - `STALL_WATCH_TARGET_NAME=<agent name>`
     - optionally `STALL_WATCH_MIN_INTERVAL` (seconds) and `STALL_WATCH_DAILY_CAP` (notices per room per day)
   - Nothing from this file is passed into the container.

Manual tick: `python3 -m reverie.stall_watch --config FILE [--dry-run]` (inside the container, as the console's user).

## Hooks wanted in host-owned code
1. **Console delivery for OpenCode panes:** a bracketed paste instead of typed keys (root cause above).
2. **A console endpoint for host services to post a room notice** as `system` (with a service token).
3. **Optionally,** OpenCode's prompt mode in the session object, as `paneDialog` is.

See [runtime configuration](runtime-configuration.md) for neutral model defaults, profile section keys, and required user-service environment files.
