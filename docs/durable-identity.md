# Durable agent identity across restarts (design v2, for review)

## Finding (read-only, 2026-10-15)

Codeman already keeps session ids across a host reboot. The boot pass
(`restoreMuxSessions`, then `planRebootRestoreOffer`) builds an offer from `state.json`,
and the reboot-restore route rebuilds each session with `id: saved.id`, resuming its
conversation. Every room, company and runtime binding keyed on that id survives.

Both of today's restarts skipped this path because `looksLikeHostReboot()` returned
false. It requires the **host** to have booted after the newest session activity. Host
uptime was ~18.5 days, so a container-only restart can never pass. With no offer,
`finalizeRestoredState` prunes the dead records (lifecycle: `mux_died`, `stale_cleaned`),
and sessions come back with new ids. `reboot-restore.ts` documents this gap and proposes
the fix used here.

## Design

1. **Container restarts produce the reboot-restore offer** (console patch, UI-independent).
   - When `isRunningInContainer()`, the boot test uses the container's own boot time:
     PID 1's start time from `/proc/1/stat` plus host boot time, instead of the host's.
   - Still required: no live panes and dead persisted sessions.
   - Result: same ids, same bindings, nothing to rebind. The offer stays a click and the
     restored sessions come back idle and disarmed, as upstream intends.
   - Tests: a pure-function case per signal, plus a container-restart fixture.
2. **Codeman is the only live binding store.** Rooms, company and runtime state keep
   pointing at session ids, which now persist. No second binding store is added.
3. **An intent registry only for a true respawn** (a session that cannot be resumed).
   - Location: `/instances/<instance>/runtime/identities.json`.
   - Contents: per identity, the launch spec, the memberships it should hold, and its
     history. It never holds the live binding.
   - It feeds the same reboot-restore route instead of adding a third rebind mechanism
     (beside the watcher's `restore_bindings`).
   - Keys are owner-assigned. The company employee id is an optional attribute.
4. **Temporary workers do not survive a restart unless restored by the offer.**
   They have no registry entry. A temporary worker that was not restored is removed from
   its rooms and from `temporaryAgents` at the next reconcile, and the removal is logged.
5. **Owner actions on the registry:**
   - `move <identity> <session>` records an intentional move, so reconcile never
     reverts it.
   - `reconcile` is read-only.
   - `--apply` keeps a per-entry status. Re-running it skips finished entries, resumes
     partial ones, and stops on ambiguity with an owner action.
6. **Registry write safety:**
   - an flock on `identities.json.lock`
   - a top-level `version` and a per-entry `rev` (compare-and-swap)
   - temp file, fsync, rename, then fsync the directory
7. **Invariants**, checked on every write: one live session per identity and one identity
   per session. Room delivery for an identity whose binding is unresolved is held
   (queued), not typed into some other pane.
8. **Audit:** every rebind, move and prune is appended to `identities.log` (JSONL: time,
   identity, from, to, actor, evidence).

## Blocked on the owner

**Owner authentication.** Today the console treats a request without
`X-Codeman-Parent-Session` as the owner (`ownerOnly`, `caller()`). An agent can unset
`CODEMAN_SESSION_ID`, or use curl, and act as the owner: rebind employees, take the
coordinator role. Until owner-only routes require a credential agent panes do not have:
- No `--apply`.
- No member-replace route.
- No unattended rebind.

Proposal for the owner: an owner token kept outside every agent mount (a host file, or the
Plans-page browser session) and required by owner-only routes.

## Order of work

1. Owner decision on authentication.
2. The container boot signal (item 1), which removes most of the problem by itself.
3. The registry (items 3–8), only for respawns.
4. Tests for every failure mode: a forged owner, an ambiguous match, partial apply and
   resume, a concurrent writer, an unbound identity's delivery, and the temporary-worker
   prune.
