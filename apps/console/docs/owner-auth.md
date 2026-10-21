# Owner sign-in and the owner/agent route policy

The console's owner signs in with a password and, optionally, a second step: an authenticator-app
code (TOTP) or a one-time recovery code. Once an owner account exists, a policy decides which
routes need the owner and which agents may call.

## Setting up (host)
| Command | Effect |
|---|---|
| `reverie owner bootstrap --username <name> [--enforce]` | Creates the account and prints a **one-time password** once. `--enforce` starts it in `enforce` (a fresh native install); it only raises the policy. It expires after 30 minutes, and the first sign-in must replace it. Run it from a host shell (not a Reverie session or pane) just before signing in, so no agent sees it. There is deliberately no web "first run" setup: every agent shares the console's loopback, so whoever asked first would own the console. |
| `reverie owner policy log` | Allows everything and records in `owner-auth-audit.jsonl` what `enforce` would refuse. This is the default after bootstrap, except on a volume the image entrypoint started: it writes the `enforce` marker when there is neither an account nor a marker, and bootstrap keeps it. |
| `reverie owner policy enforce` | Refuses as described below. `off` turns the policy off. |
| `reverie owner reset-password` | Lockout recovery: a new one-time password; every session ends. Two-step stays on. |
| `reverie owner reset-2fa` | Lost authenticator: removes two-step, recovery codes and remembered devices; every session ends. |
| `reverie owner unlock` | Clears a sign-in lockout. |
| `reverie owner logout-all` | Ends every session and forgets every remembered device. |
| `reverie owner keepers [list\|add\|remove] [cto\|employee id]` | Names the agents (by company employee, or `cto`) that may nudge, interrupt and read any agent session. |
| `reverie owner service-token issue\|revoke <name>` | Manages a token (printed once) for a host service, sent as `X-Reverie-Service-Token`. |
| `reverie owner status` | Account state, without secrets. |

Every `reverie owner` command refuses to run inside an agent session (`CODEMAN_SESSION_ID` set), and
every action is written to the audit log as `host-cli`.

## Signing in (browser or installed phone app)
`/owner/login`: username and password, then a second step if two-step is on, then a forced
password change if a one-time password was used. `/owner/account` sets up two-step (a QR code,
confirmed by the first code; 10 recovery codes are shown once), lists and revokes remembered
devices, changes the password, signs out, and signs out everywhere.

- **Password:** scrypt (N=32768, r=8, p=1) with a random salt.
  - **Strength check:** at least 12 characters; at least 6 different characters; about 50+ bits by
    its character pools; no very common fragment (e.g. `password`, `qwerty`, `123456`); not
    containing the username.
- **Changing the password** (`/owner/account`): it needs the current password and, once two-step is
  on, an authenticator code. The forced first change doesn't need the code: its sign-in already
  passed the second step.
  - A change ends **every other** session and remembered device.
  - The browser making the change stays signed in, and keeps its own remembered device.
- **TOTP:** RFC 6238 (SHA-1, 6 digits, 30 s). A code is accepted within ±1 step, and never twice:
  the last accepted step is remembered.
- **Recovery codes:** 10 codes, each ~60 bits, stored as SHA-256. Each works once.
- **Session cookie (`reverie_owner`):** HttpOnly, SameSite=Strict, and Secure when the browser
  reached the console over HTTPS (directly or through a tunnel). It ends after 12 h idle, at 7 days
  absolute, at sign-out, at "sign out everywhere", at a password change, and at a console restart
  (sessions live in memory only).
- **Remembered device (`reverie_owner_device`):** 30 days, HttpOnly, SameSite=Strict, sent only to
  `/api/owner`. It skips **only** the second step: the password is always required. It is listed
  and revocable, and "sign out everywhere" forgets it.
- **Retry protection, per source, never account-wide**, so no caller can lock the owner out
  everywhere. Buckets are kept on disk, so they survive a restart:
  - the network source (all loopback addresses count as one)
  - a valid remembered device (its own bucket: it keeps signing in while its network source is locked)
  - an owner session (for the settings that re-check the password or a code)
- **Each bucket:** three free attempts, then 1 s doubling up to 5 min. A lockout after 10 failures
  lasts 15 min and doubles per further lockout, up to 24 h. The doubling resets after a success, or
  after a day without failures. Lockouts are audited (`lockout_started`).
- **Concurrency:** one attempt per bucket and two password checks in total run at once; others get
  429. A wrong username costs and answers exactly like a wrong password.
- **Audit log** (`owner-auth-audit.jsonl`, 0600): sign-in outcomes, lockouts, changes, and
  would-be refusals in `log` mode. It never contains a password, code or token.

## The route policy
| Class | Who may call |
|---|---|
| public | anyone: sign-in pages and endpoints, static assets, the QR/web-tab/HTML-view capability URLs, the hook endpoints (their own secret) |
| agent | the owner, agents, services: exactly what `reverie agent`, the MCP server and the plugins call (sessions list/read/input/wait/delete, quick-start, session lifecycle, chat rooms, company read, own profile) |
| service | the owner and services: agent routes plus re-binding a company employee (for the runtime watcher) |
| owner | the owner only: **everything else, including every route not yet classified** |

**Who the caller is:**
- **Owner:** a valid owner session cookie.
- **Service:** a valid service token.
- **Agent:** an `X-Codeman-Parent-Session` that resolves to a live session. That header is a routing
  hint set by agent tooling, not authentication.
- **Anonymous:** none of the above.

Classification uses the **matched route pattern**, never the raw URL (the router decodes
`%61pi`, so a raw-prefix check would be bypassable). An unmatched path is decoded first, and is
owner-only if it names `/api` or `/ws`.

**Agent session scoping:** for an agent's session routes (`input`, `DELETE`, `terminal`,
`last-response`, `wait`, `wait-output`):

**Full control** (all of them) only over:
- itself
- its descendants, through parents the console recorded

Quick-start records only the caller, or one of its own descendants, as a new session's parent. A
`parentSessionId` naming anyone else is dropped (audited as `parent_ignored`), so no agent can spawn
a child "under" another session. This covers stopped sessions' saved records too.

**Input only** (send text, interrupt with ESC; never reads, never ending a session):
- **Members of a room it coordinates,** but only through seats the owner made. Chat members record
  which agent added them (`addedBy`), so a room an agent built, or a member an agent added, never
  counts. Its own coordinator seat must be owner-made too.
- **Upward:** its parent or any ancestor, and the coordinator of a room it is in.
  - A session the runtime watcher restarted has no recorded parent. For this rule only, it inherits
    its predecessor's, from the watcher's record (`controller-state.json` next to the data dir, or
    `REVERIE_RUNTIME_STATE`).
  - That file is writable by the agents' uid, so it never grants more than input.
- **Keepers:** the host names them with `reverie owner keepers add <cto | employee id>`.
  - A session bound to such a company employee may nudge and interrupt **any** agent session.
  - It sees **status only:** the session metadata every agent may read (busy or idle, `paneDialog`,
    mode, last activity). Never another session's terminal or transcript.
  - `cto` follows the company's CTO setting.
  - Changes are audited (`keeper_added`, `keeper_removed`), and use is audited hourly (`keeper_action`; upward use as `upward_action`).
  - Employee bindings are set only by the owner or a service, so an agent cannot make itself a keeper.

Anything else is owner-only.

**Same origin:** an owner-cookie request that changes state, or opens a WebSocket, must carry an
Origin whose host equals the Host header. Same-site pages on another port or tailnet name cannot
ride the cookie. Proxied web-tab documents are always served with a CSP `sandbox` (no
same-origin), and the owner cookies (`reverie_owner*`) are never forwarded to a web tab's upstream,
on the HTTP or the WebSocket path, even for a trusted tab.

**What `enforce` refuses:**
- An anonymous call gets 401, and a browser opening the app is sent to `/owner/login?next=…`.
- An agent or service on an owner route gets 403.
- A session signed in with a one-time password reaches only the password change.

## Threat note: what this does and does not stop
**Stops:**
- Network callers: anyone on the LAN or a tunnel can no longer act as the owner, once in `enforce`.
- Honest-but-wrong or prompt-injected agents: a header-less `curl` or a forged header no longer gets
  owner authority.
- Online password guessing (backoff, lockout, two-step), stolen-password sign-in (two-step), and
  replayed codes.

**If the account file goes missing or corrupt**, the console keeps the last known policy (fail
closed): owner sign-in stops (503) until the host repairs it, while agent routes keep working. The
policy is also written to `owner-auth.policy` next to the account, so a console restart after the
account file was deleted still keeps it; only removing both turns it off.

**Sign-out closes live connections:** a sign-out, sign-out-everywhere or password change closes the
WebSocket and event-stream connections of the ended sessions. Expired ones are closed within a
minute.

**Does not stop:** a deliberately malicious agent **inside the container**. Agents run as the same
user as the console and have passwordless sudo there, so they can read or change
`owner-auth.json`, the console's code and its memory. Closing that needs host-side isolation:
remove agent sudo, run the console as a separate user, keep the account file outside agent reach.
Phone numbers and SMS are not used.
