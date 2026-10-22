# Routines (R1): status rounds, calls, retro and kickoff

A host timer runs `reverie-routines tick` every 5 minutes. R1 does two things:
- It checks each listed agent's session **status** and reports what it sees (stalled, open
  dialog, down, recovered, identity changed).
- It sends a one-line wind-down call before each agent's sleep window and a wake-up call after
  it.
- **Daily retro (R1 v3):** it asks each lead for a retro and the coordinator for the compiled
  summary.
- **Morning kickoff (R1 v3):** it asks the coordinator for the kickoff.
- **Cron count (R1 v3):** it reports how many console cron jobs exist, as a count only.

It never nudges, never restarts anything, and never reads or posts to a chat room. Design:
`reports/routines-and-collective-memory-design-v2.md` plus its delta review, and
`review-routines-r1.md` (F1-F9).

## Trust rules

- **Host-held.** The policy (`~/.config/reverie/routines.json`, owner-written), the ledger
  (`~/.local/state/reverie/routines.sqlite`) and the token (`~/.config/reverie/routines.env`,
  mode 0600) are all host files.
- **No container commands.** The tick runs no container command. Its only agent-writable input
  is the optional night-cycle policy, and that input is report-only (see below).
- **Console calls:**
  - `GET /api/v1/sessions`: once per tick. Status fields only; pane and dialog text are never
    read beyond "present".
  - `GET /api/v1/sessions/<id>`: a re-check of that one session immediately before each send.
  - `GET /api/cron/count` (console patch C7, count only), or, while that route does not exist
    (404), `GET /api/cron/jobs`: the **number** of console cron jobs only. Job definitions are
    never read beyond their count or logged.
    - Reported as `cron_jobs <n>` once a day while n > 0, and `cron_jobs_grew <n>` at once when
      n grows.
    - Under owner-auth `enforce`, `/api/cron/*` is owner-class. `GET /api/cron/count` must then be
      in the service route set (exactly that path), or the tick reports `cron_unknown` once a
      day.
  - `GET /api/subscription-profiles/usage`: only when `quota` is set (the retro/kickoff quota
    gate).
  - `POST /api/v1/sessions/<id>/input`: one fixed line plus Enter. Untagged: no
    `clientId`/`seq`, so the console's duplicate filter can never drop it silently. A reply
    that says the input was buffered or dropped counts as failed.
- **No room reads.** The room list carries each room's last message.
- **No room posts.** Reports are coded lines in the journal and
  `~/.local/state/reverie/routines-reports.log`:
  `routines-report v1 <time> <code> <agent> <number> [dry-run]`. Nothing is posted as the user.
- **Fixed templates.** Every text sent is a fixed template: one printable ASCII line, no `!`
  (typed delivery would flip OpenCode into shell mode).
- **The shared marker.** Each starts with the reverie's marker,
  `[automated - not the owner - routine <kind>]`. The marker is **unauthenticated**: anyone can
  type it. It only ever lowers trust and never proves who sent a line.
- **Cost.** Every call and routine line is a model turn on the receiving agent, so it costs that
  agent's quota.
- **Port.** `127.0.0.1:3001` is the host-published port of the container's `:3000`. The tick runs
  on the host, so 3001 is correct.

## Identity: pinned session ids

Each agent is pinned by its persistent session **id** (`session_id`); the **name** is only
cross-checked. Any caller can rename a session, so:

| what the tick sees | result |
|---|---|
| the pinned id is live with the right name | normal |
| the pinned id carries a different name | `renamed`: nothing sent, until the owner checks and re-pins |
| the pinned id is gone or stopped, and another live session has the name | `moved`: nothing sent; the name is never followed to another id |
| the pinned id appears twice | `unknown` |
| the pinned id is gone or stopped, and nothing else has the name | a down observation |

After a deliberate restart that changes an agent's id, update `session_id` in the policy.

## What a tick does

| status | action |
|---|---|
| console error, 5xx, empty or malformed list | `unknown` for all: nothing sent, every down streak starts over, `console_unknown` at most hourly |
| down observation | **Down is confirmed by two observations at least 4 min apart, each within 15 min of the previous one.** Ticks under a minute apart count once; `unknown`, `moved` and `renamed` reset the streak. Then `down` is reported once per episode, and `recovered` when it returns. R1 never restarts. |
| pane dialog open ≥ `dialog_minutes`, awake | `dialog` reported once per round. Never typed into. |
| busy, no pane activity for ≥ `stall_minutes`, awake | `stalled` reported once per round. **Never typed into (F1):** while a turn runs, the console does not flag dialogs, so a stuck permission prompt looks exactly like this, and Enter would answer it. |
| inside the sleep window | no stall or dialog reports; down tracking continues |

**One sleep guard for every kind.** Nothing timed (wind-down, wake, retro, retro-compile,
kickoff) is ever sent to an agent inside its sleep window.

**Calls**
- Wind-down is due `wind_down_minutes_before` the window starts, and stays valid for 30
  minutes.
- Wake-up is due `wake_after_minutes` (default 15) **after** the window ends, giving the night
  cycle room to finish, and stays valid for `wake_retry_minutes`.

A call is typed only when **both** the tick's list and the re-check just before the send show
all of the following:
- the pinned id with the right name
- live
- not busy
- no dialog
- pane activity known and at least 60 seconds old (longer than the console's 30-second dialog
  scan)

A failed re-check types nothing and leaves the slot open for the next tick inside the window.
A call not delivered in its window is recorded `missed` once and never sent late. Slots due
before the ledger's first tick are recorded without a report.

**Retro and kickoff**
- These are fixed host texts. The policy sets only times, recipients and the leads.
- **Retro:** at `routines.retro.at`, each agent with `lead: true` gets the retro line, staggered
  `stagger_minutes` apart in policy order. `compile_after_minutes` later, the `compiler` (the
  coordinator) gets the compile line.
  - The compile line asks for every point to be attributed to its lead and labelled unverified
    (self-reports).
  - A compiler that is also a lead gets **no separate retro line**; its own retro is folded into
    the compile. That keeps the coordinator at one routine input for the retro.
  - The host never reads the replies or the summary; compiling is the coordinator's own turn.
- **Kickoff:** at `routines.kickoff.at`, the `to` agent gets the kickoff line.
- **Rules:**
  - Idle-only delivery, the same as calls.
  - A validity window (`valid_minutes`), then `missed` once, never sent late.
  - `weekdays_only` skips Saturday and Sunday.
  - Their own counter, `caps.routines_per_day` (max 3), separate from `calls_per_day`.
- **Load-time validation:** a policy is refused if any routine send (each lead's staggered time
  included) falls between that agent's `sleep.start - wind_down_minutes_before - 30` and
  `sleep.end + wake_after_minutes + 30`.
- **Quota gate:** a `quota: {"profile", "reserve_percent", "max_age_seconds"}` section is
  **required** whenever a retro or kickoff is configured.
  - A routine is sent only while that plan profile's reading is `ready`, fresh, finite, before
    its reset, and below `100 - reserve` in every window.
  - Otherwise it is **deferred** (`<kind>_deferred_quota`, once per slot) and retried on later
    ticks inside its window, ending `missed` if the gate never opens.
  - Nothing is ever sent while the gate is closed or unreadable. Calls are not quota-gated.

**Pause.** `touch ~/.local/state/reverie/routines.paused` stops all sends; reports continue.

## Caps (what is enforced)

All caps are counted in the host ledger, which the container cannot write. A failed send still
counts.

| cap | default | enforced by |
|---|---|---|
| calls per agent per local day | 2 (max 2) | ledger count |
| retro/compile/kickoff per agent per local day | 3 (max 3) | ledger count, separate from calls |
| one wind-down and one wake-up per agent per date | — | ledger key `(kind, agent, date)` |
| nudges | none in R1 | no nudge code path |
| reports | once per slot per code | ledger key |

The ledger row is written **before** each send. A row that cannot be written means no send, and
a corrupt state file stops the tick (exit 3) without sending.

**Clock jumps.** The day key is the local date at tick time. A forward jump across midnight
starts a new day, so a skew event can allow the day cap twice, once. A backward jump keeps
counting under the old date. Per-slot keys still prevent any repeat within a slot.

**Down while intended.** An agent the owner stopped on purpose is still reported `down`, once
per episode. Remove it from the policy, or set `calls: false`, if that is noise.

**Cycle policy.** With `cycle_policy` set to the host path of the night cycle's policy, a
differing timezone or sleep window is reported (`policy_mismatch`), and the host policy still
rules. The file is read **last**, after any sends, and only if it is:
- a regular file
- not a symlink
- at most 64 KB
- opened non-blocking

Anything else is `cycle_policy_unreadable`. A file agents can edit can neither stop the tick nor
switch routines off.

## Token (F7)

Issue a **dedicated** service token for routines, never the stall-watch one, so it can be
revoked on its own:

```sh
reverie owner service-token issue routines        # on the host (owner-auth v5)
install -m 0600 /dev/null ~/.config/reverie/routines.env
# REVERIE_SERVICE_TOKEN=<token>   (it never enters the container)
```

- **Treat it as owner-equivalent.** Service tokens are not scoped yet, so this token could do
  anything the console allows, even though the code only uses the three calls above.
- **Without a token** under owner-auth `enforce`, every read is refused. The tick then only
  reports `console_unknown`, so even a dry run needs a read-capable token.
- **No proxies, no redirects:** the client follows no redirects (urllib would re-send the token)
  and uses no proxies.

## Policy

See `examples/routines.json`. Fill in each `session_id`; until then the example is refused. The
policy is validated strictly, and any error refuses the whole tick (exit 2).

**Per agent**
- `session`: the console session name, cross-checked.
- `session_id`: the pinned id.
- `sleep`: `{start, end}` as HH:MM; it may wrap midnight.
- `calls`: optional, true or false.

**Global**
- `timezone` (IANA)
- `coffee`: `every_minutes`, `stall_minutes`, `dialog_minutes`
- `calls`: `wind_down_minutes_before`, `wake_after_minutes`, `wake_retry_minutes`
- `caps.calls_per_day`
- `cycle_policy`

## Install (owner, on the host)

Build from a **verified clone**, never from `~/git/reverie`: agents can write that tree through
`/workspace`. Once the ops runner exists, it builds host tools from its own host-only repo.

```sh
git clone --no-local ~/git/reverie /tmp/reverie-verify && cd /tmp/reverie-verify
git checkout <reviewed commit> && git rev-parse HEAD          # compare with the reviewed hash
nix build .#default -o ~/.local/libexec/reverie/reverie-pkg
ln -sf reverie-pkg/bin/reverie-routines ~/.local/libexec/reverie/reverie-routines
cp examples/routines.json ~/.config/reverie/routines.json     # then edit: ids, windows
~/.local/libexec/reverie/reverie-routines check-policy
cp systemd/reverie-routines.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now reverie-routines.timer
journalctl --user -u reverie-routines.service      # dry run: "..._would_send" lines
~/.local/libexec/reverie/reverie-routines status      # the dry ledger; add --live for the live one
```

**Without Nix.** The module is standard-library only, so a host `python3` (3.11 or later) can
run it from the verified clone: `nix develop --command python3 -m reverie.routines tick`.

**Going live.** Add `Environment=ROUTINES_FLAGS=--live` in a drop-in. Dry runs keep a separate
ledger (`routines.dry.sqlite`), so going live starts clean.

## Not in R1

- Nudges (they need a dialog-aware probe).
- Restarts (R3, after H3).
- News (R2).
- Room posts (C1).
- The "quiet" state (C2).
- Reading stall-watch or cycle state from the container.
