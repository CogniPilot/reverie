# Feature brief: Session tab detach / undock (for Reverie)

> ✅ **SHIPPED — on GitHub as PR #103 (open).** Branch `beta/session-detach` on
> `jgoppert/reverie` (base `master`): "feat(web): session detach/undock + beta
> instance isolation (port 5000)", containing detach/undock + instance isolation
> + the base gesture overlay (commit `afea6d6`). `app.detachSession(id)` in
> `app.js` opens `/session/:id` as a solo window (another live client of the same
> session), tracks it (badge + `BroadcastChannel` sync + re-dock on close), and is
> the single idempotent entry point both the on-tab ⧉ icon and the gesture layer
> call. PTY fan-out (the open question below) resolved **yes**, so no streaming
> work was needed. CI green after I fixed a prettier format:check on `auth.ts`
> (commit `ceca853`).
>
> ⚠️ **Note:** the local **prod** clone `~/.reverie/app` only tracks `master`, so
> the PR branch is invisible there until `git fetch origin beta/session-detach`.
> (Earlier today I briefly mis-concluded the PR didn't exist and made a bogus
> local reconstruction — deleted. The PR was real all along.) The gesture-side
> *improvements* from this session — direct-detach, Run/Run Shell pinch-taps,
> self-hosted MediaPipe, `server.ts` cache-bust — were **ported onto PR #103**
> (commit `eea84db`, CI green); their source is `Ark0N/codeman-gesture-control`.
> The rest of this doc is the original hand-off brief, kept for history.

> Hand-off brief for **Reverie** to refine and implement **on a beta branch**.
> Authored from the gesture-control project, which needs this as a prerequisite.
> Reverie is "aireverie": a Fastify + WebSocket server streaming xterm.js
> terminal (tmux) sessions to a web dashboard.

## Goal

Let a session "tab" pop out of the main dashboard into its **own browser
window** (and back). Each detached window shows just that one session's
terminal, fully live. This is a standalone UX win *and* a prerequisite for
gesture control later (a hand-gesture "drop" will eventually trigger
detach/relocate — but that's a separate project; **this feature is plain UI
buttons only**).

## Core approach (refine as needed)

- Add a **"Detach" control** on each tab. It opens a new browser window
  (`window.open`) pointing at a **single-session view** — ideally a real route
  like `/session/:id` so the popup just loads a URL and attaches like a normal
  client.
- The detached window runs its **own xterm.js instance connected to the same
  session's WebSocket**, so it's live, not a screenshot.
- Keep the dashboard and detached windows **in sync** (session list, titles,
  alive/dead state, focus) — via the existing events channel, or a
  `BroadcastChannel` if simpler.
- Support **re-dock** (close popup → tab returns to the dashboard) and handle the
  popup being closed/refreshed gracefully.

## The one critical question to resolve first (in Reverie's own code)

Can the server currently **fan out one session's PTY/tmux output to multiple
concurrent WebSocket clients**, or is it single-consumer? A detached window is a
*second* viewer of the same session. If it's single-consumer today, that's the
main change: make the pty→socket stream **broadcast to N subscribers** (and merge
input) so dashboard + popup can both watch/type. This likely matters more than
the UI work.

## Other decisions for Reverie

- Per-session route (`/session/:id`) vs. a single-page popup that's told which id
  to show.
- Multi-monitor placement later via the Window Management API
  (`getScreenDetails`) — **out of scope now**, just don't design against it.
- Auth/cookie sharing so a popup window authenticates the same as the dashboard.

## Constraints

- Implement on a **beta branch**, not `main`.
- The gesture-control side keeps a **read-only** copy of Reverie (its `.git`
  removed); the live `jgoppert/reverie` repo is **not** touched from here. Reverie
  implements this itself.

## Why this is sequenced before gesture wiring

Gestures can only drag DOM **within the single page that owns the camera**; you
cannot drag a node across isolated browser tabs / OS windows. So undock must be a
**Reverie session-placement operation** that a gesture `drop` later *triggers* —
not something the gesture layer does. Detach first; wire gestures to it after.
