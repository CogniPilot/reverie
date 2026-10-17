# Experts API

An expert template describes a specialist that can be hired as a company employee with its
own session. Templates, settings and hire records are instance data in
`<data dir>/experts.json` (mode 0600; each write goes to a temp file, is synced, then
renamed). They are never kept in the repository.

## Seeding

When `experts.json` does not exist yet, the first read seeds it from the `*.json` files in
`FLEET_EXPERTS_SEED_DIR`. If that variable is unset, no seeding happens and the list starts
empty. A seed file that is invalid is skipped and logged. A damaged `experts.json` is
reported (503) and is never overwritten.

## Template

| Field | Rule |
|---|---|
| `id` | slug from the path: lowercase letters, digits, `-`, `_`; 64 at most |
| `name` | one line, 1-40 characters |
| `icon` | one emoji or at most two characters |
| `role` | one line, 1-80 characters |
| `persona` | 1-4000 characters |
| `expertise` | at most 12 short strings (60 characters each) |
| `kind` | `expert` or `implementer` |
| `defaults` | `{ mode, model?, effort?, accountProfileId? }`; `mode` is a CLI id from the registry |
| `rooms` | room ids the hire joins; each must exist when the template is saved (400 otherwise) |

Unknown keys are refused. A template has no data directory field, because the runtime
always assigns one. It also has no initial self-model or directive list: a hire gets the
runtime's fixed defaults and safeguards, and a template cannot set or remove them. Any
string that looks like a credential (for example an `sk-` or `ghp_` token, a private key
block, a run of 40 or more base64url characters, or a URL with a password) is refused. The
error names the field and never echoes the matched text.

## Routes

| Route | Who | Notes |
|---|---|---|
| `GET /api/experts` | anyone | templates, hire records, current counts against the caps |
| `GET /api/experts/:id` | anyone | one template and its hire records |
| `PUT /api/experts/:id` | owner | create or replace a template |
| `DELETE /api/experts/:id` | owner | refused (409) while the template has an active hire |
| `PUT /api/experts-settings` | owner | `{ hireDelegates[], maxHiresPerDay, maxActive, noticeRoomId?, requireBudgetStopForDelegates, delegateWorkingRoot?, budgetStopGraceMinutes }` |
| `POST /api/experts/:id/hire` | owner or delegate | `{ workingDir, mode?, model?, effort?, accountProfileId?, reason, budgetStop? }` |
| `POST /api/experts/:id/retire` | owner or delegate | `{ sessionId, reason }` |

**Owner only.** A request that carries an `X-Codeman-Parent-Session` header with any value,
even an empty one, gets 403 and changes nothing. The header is a routing hint and does not
authenticate anyone. Under the owner policy, the template and settings routes are
owner-only. The two GET routes and hire/retire are open to agents, and they make their own
decision.

**Delegates.** An agent session may hire or retire only if its resolved session id is in
`settings.hireDelegates`. Only the owner edits that list. A delegate hire uses the template's
launch: a `mode` or `accountProfileId` in its body is refused (403), and its `workingDir` must
resolve (through symlinks) to `settings.delegateWorkingRoot` or below it (403 otherwise). While
`delegateWorkingRoot` is unset, every delegate hire is refused (403). A delegate may still pick
`model` and `effort`. With `requireBudgetStopForDelegates` (default false) a delegate hire without
a `budgetStop` is refused (400). Nothing is created by a refused hire.

## Hiring

1. Caps: `maxHiresPerDay` (default 2) counts every hire in the last 24 hours, retired ones
   included. `maxActive` (default 5) counts hires that are not retired. At a cap the request
   gets 409. Nothing is retired or trimmed to make room.
2. A notice room must be configured, either as `settings.noticeRoomId` or as
   `FLEET_EXPERTS_NOTICE_ROOM`. Without one, hiring is off (503).
3. The session is created by an in-process request to `POST /api/sessions` (that route's
   handler has no separate creation function). It carries the caller's own cookie,
   authorization, origin and host, and never an agent header, and the owner policy checks it
   again. An owner hire passes the same checks as a direct request. A delegate has no owner
   cookie, so under `enforce` the request is refused (401) and the hire fails with nothing
   created: delegate hiring works only while the policy is `off` or `log`. In those modes the
   session route sees the request as the owner's, which is why the delegate limits above are
   checked first.
4. The session is registered as a company employee (`position` = role). Nightly research is
   off.
5. The employee is invited to each template room, and to the notice room when the hire has a
   budget stop.
6. The hire record is saved and one notice is posted to the notice room.
7. An admin-audit line `{action: "expert_hire", target, detail: {template, sessionId, by}}` is
   written before the response.

If any step after the session is created fails, the hire fails and the steps already taken
are undone in reverse order: the hire record, room membership, the employee record, the
session and its temporary-worker profile. A notice that cannot be posted counts as a
failure (503).

## Retiring

Retiring stops the session through the console's normal session cleanup
(`cleanupSession(id, true)`) and marks the hire `retired`. An audit line (`expert_retire`) is
written, and a notice is posted when a notice room is configured.

- Removed: the session itself, that is its row in the console state, its running process and
  terminal, its paste-upload folder and its per-session launch files.
- Kept: the hire record, the employee record, the working directory, the agent's memory and the
  CLI's own transcripts.

The retire notice states the same.

## Budget stop

A hire may carry `budgetStop: { planId, weeklyPercent }` (`weeklyPercent` 1-100). The owner or a
delegate sets it in the hire body; it is stored on the hire record. `planId` is a plan id as
`GET /api/plans` lists it. When the plans can be read, an unknown `planId` is refused (400).
When the plan's reading is fresh (2 hours old at most) and already at or past `weeklyPercent`,
the hire is refused (400, `budgetStop: plan <id> is already at N% weekly`). When the plans
cannot be read at hire time the stop is accepted and the check below reports it.

Every hour (and about a minute after the console starts) the console reads the same plan rows
as `GET /api/plans` and compares each active hire's plan weekly figure (the seven-day used
percentage) with its `weeklyPercent`:

1. Below the limit: nothing happens.
2. At or past it: `budgetStop.triggeredAt` is saved on the record, the session gets a chat
   message addressed to it in the notice room ("Budget stop: save your work and write a
   handoff now; this session stops in N minutes."), and a notice is posted. If that message
   cannot be sent (or there is no channel to the session), the notice says so: "the session
   was NOT told (reason); retiring anyway in N minutes." It never claims a request that was
   not delivered.
3. After the grace (`budgetStopGraceMinutes`, default 10) the hire is retired through the same
   path as the retire route, with `retiredBy: "budget-stop"`, and the retire notice is posted.
   Because `triggeredAt` is on the record, a console restart during the grace resumes the
   countdown; it is never restarted or skipped. Each hire is checked on its own: if one
   retirement fails (its session does not stop, or the record cannot be saved), the others are
   still checked, a notice "Budget stop could not retire session X: <reason>; retrying hourly."
   is posted at most once an hour per hire (`budgetStop.retireFailNoticeAt`), and the next pass
   retries it.
4. A missing reading (plans unreadable, the plan not listed, no weekly figure) or a stale one
   (taken more than 2 hours ago) never stops a session and never passes silently: a notice says
   the budget stop cannot be checked, at most once a day per hire
   (`budgetStop.uncheckedNoticeAt`).

Template changes are audited as `expert_template_set` (with a SHA-256 of the persona, never
the text), `expert_template_delete` and `expert_settings`.
