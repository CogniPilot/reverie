# Owner authentication for the console (design notes, for review; no code)

## Problem
The console decides "is this the owner?" by the **absence** of `X-Reverie-Parent-Session`.
- Agent tooling sets that header; the owner's browser does not.
- So any request without it is treated as the owner: an agent with `curl`, a script with
  `REVERIE_SESSION_ID` unset, or anyone who can reach the listener.
- The H2 stopgap closed the "bogus header" variant on chat-room routes. The "no header" variant is
  open everywhere. Inventory: `reports/owner-header-stopgap-README.md`.
- The inventory, in short:
  - **Explicit owner checks:** about 20 chat-room decisions, plus company (`ownerOnly`), CLI
    management, external chat, `POST /api/voice/turn` (posts as the user with no check) and the
    owner avatar routes.
  - **Everything else** (sessions: kill, delete, input, respawn; settings; files; cases; admin;
    cron) has no owner/agent distinction at all.

## Facts that decide the design (checked 2026-10-15, live container)
| Fact | Consequence |
|---|---|
| The console listens on `0.0.0.0:3000` with `--allow-unauthenticated-network`, and no password is set | Anyone who can reach the port is the owner. Review the instance network and authentication configuration before exposing it. |
| The console has HTTP Basic auth with session cookies (`web/middleware/auth.ts`, `REVERIE_PASSWORD`, cookie `reverie_session`) | A login and cookie mechanism already exists and can be reused. |
| Agent tooling reads the **same** password from the data dir's `.env` (`reverie-credentials.ts`) | Turning the password on stops the network, but does not tell the owner apart from agents. |
| The console and all agents run as uid `agent`; the data dir is `0700 agent` | Every file the console can read or write, an agent can too: tokens, password hashes, settings. |
| `/proc/<console>/environ` is readable by agents; `/proc/<console>/mem` is not (Yama `ptrace_scope=1`) | A secret held only in console memory resists a non-root agent; one in env or on disk does not. |
| **Agents have passwordless `sudo` in the container** | A determined agent is root. It can read process memory, sniff loopback, and edit `/opt/reverie/apps/console` or the data dir. **No in-container check can stop a malicious agent.** |

## Threat tiers (the owner chooses the target)
- **T1: network.** Anyone on the LAN or tunnel acts as the owner. *Fixable now, inside the container.*
- **T2: honest-but-wrong agents.** A confused or prompt-injected agent calls an owner route without a
  header (a common `curl`), or impersonates the owner in chat. *Fixable inside the container:* it
  must hold, as long as the agent does not deliberately hunt for a credential.
- **T3: a deliberately malicious agent.** It reads secrets, patches code, uses root. *Not fixable
  inside this container.* It needs host-side isolation (D below).

## Design
### A. Owner credential: browser only (T1, T2)
- **Owner login:** a passphrase, hashed with scrypt.
  - The hash is stored **outside the agent-readable data dir** if possible (D1).
  - Otherwise it goes in a separate 0600 file, and agents are instructed never to read it. That
    deters T2, but not T3.
- **Login:** `POST /api/owner/login` returns an **owner session**: a 256-bit random token held
  only in console memory. It is sent as an `HttpOnly; Secure; SameSite=Strict` cookie, with a
  sliding 12 h TTL and a manual "log out everywhere" action.
  - Never in env, never on disk. With Yama 1, a non-root agent cannot read it.
- **CSRF:** `SameSite=Strict` plus an `Origin`/`Host` check, which `network-auth-policy.ts`
  already has, on every owner-only write.
- **Phone (Pixel 8 PWA):** the same cookie. Web Push subscriptions bind to the owner session.
- **Migration:** the owner sets a passphrase once (a first-run screen, or `reverie owner set-passphrase`).
  Until it is set, the console keeps today's behaviour but shows a persistent banner. That avoids a
  lock-out mid-class.

### B. Agent identity: per-session tokens (T2)
- At spawn, the console mints a per-session token and gives it to that session's process, in an
  env var or a file in the session's own dir.
- The CLI and plugins send `Authorization: Reverie-Session <token>` alongside the existing header,
  so the header name and protocol stay compatible.
- The console maps token → session. A token can never be an owner session.
- **Limit (same uid):** an agent can read another agent's token from `/proc/<pid>/environ`. That
  lets it act as **that agent**, never as the owner. Acceptable at T2; T3 needs D.

### C. Route policy: default owner-only, with an explicit agent allow-list
- **Every route is classified.** Unclassified means **owner-only**, so a new route is safe by default.
- **Owner-only routes** require the owner cookie. A request with neither cookie nor agent token is
  refused (**401**), replacing "no header means owner".
- **Agent-allowed routes** (initial list, to be reviewed):
  - chat: say, read, who, status (self only), rooms
  - self-profile and self-avatar
  - `agent ls`/`read`/`send` to sessions the agent spawned or shares a room with (today: any; to be narrowed)
  - spawn under the agent's own lineage
  - hook events (already guarded by `hook-secret`)
- **Owner-or-coordinator routes** (room members, re-brief) take either. "Coordinator" comes from the
  agent token's session, not from a header.
- The header becomes a routing hint only: it must equal the token's session, or the request is refused.
- **Watcher and host units:** the host-side watcher currently calls with no header (so, as the
  owner). It gets its own service token with a narrow allow-list: sessions read, quick-start, and
  bindings restore. The token sits in a host file passed by `podman exec --env`, not in the data dir.

### D. Isolation: the only real T3 fix (host work, separate approval)
1. **Drop agent root.** Remove passwordless `sudo` for agent sessions (keep a separate admin path for the host).
2. **Separate uids.** The console runs as `reverie` and agents as `agent`. The console's data dir is
   `0700 reverie`, and the code under `/opt` is root-owned and read-only. Agents talk only over HTTP.
3. **Owner passphrase hash on the host**, bind-mounted read-only into the console's uid only.
4. **Loopback sniffing** is then impossible without root. Keep the console on a Unix socket or
   loopback inside the container; reach it from outside via the host's TLS proxy or tunnel only.

Steps 1 and 2 change the container, which the host owns. They are listed so the owner can choose
T3 deliberately; nothing in A to C depends on them.

## What this changes for users
- **Owner:** logs in once per device (passphrase). The phone keeps the cookie. Owner actions are
  unchanged once logged in.
- **Agents:** no change to commands. The CLI and plugins send their token automatically, and owner
  routes return 401 instead of silently working.
- **Network:** with A in place, `--allow-unauthenticated-network` can be dropped.

## Rollout (each step separately reviewed)
1. **A**, behind a setting: login, the cookie, and the banner when no passphrase is set. No route changes yet.
2. **B:** mint and send agent tokens; log any header-only agent calls (no enforcement).
3. **C**, enforced in stages: first the inventory's explicit owner checks, then default
   owner-only, with the allow-list built from the log in step 2.
4. Drop `--allow-unauthenticated-network`.
5. (Optional, owner decision) **D** on the host.

Each step: route tests per class (owner cookie, agent token, none, forged header, another
agent's token), a mutation check, and a restart window outside class hours.

## Decisions for the owner
1. **Target tier:** T2 (A to C) now, and D later or never?
2. **Passphrase location:** the host (preferred) or the container's data dir?
3. **Agent allow-list:** confirm the initial list in C, especially `agent send` and `rm` to other sessions.
4. **Lock-out policy:** the banner (default) or refuse until a passphrase is set?
