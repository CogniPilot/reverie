# Assignment status and public GitHub issue bots

These are fixed, typed website jobs. They use the existing named bot registry, room allowlists, normal phone delivery and hourly posting caps. They never run a model, shell command, agent, provider start or credential lookup. They are disabled until a verified owner configures them. Existing text routines and PR watchers are unchanged.

Owner-only `GET /api/bot-watches` reports configuration, pending attempts, last poll/tick, response history and coverage gaps. Owner-only `PUT /api/bot-watches/assignments` and `/api/bot-watches/github-issues` accept the closed schemas below. Agents and limited human accounts cannot enable or inspect these private histories. Removing a registry identity or disabling its watch stops new effects. Multi-user activation is refused until the Board has an explicit owner partition.

Create the named senders with the existing owner-only `PUT /api/chat-bots/:id` route. Select actual ordinary rooms in that sender's allowlist; no sample identity or room is automatically created.

```json
{
  "version": 1,
  "type": "assignment-status",
  "enabled": true,
  "botId": "assignment-status",
  "roomIds": ["OWNER_SELECTED_ROOM"],
  "intervalMinutes": 60,
  "responseMinutes": 15
}
```

Only assigned `doing`/`blocked` tasks are checked. Completed, unassigned, stopped, vacationed, migrating or non-running assignees are skipped. A task with a source room stays in that room. Missing source rooms, absent membership and blocked phones appear as explicit coverage gaps. The initial policy conservatively requires a ringing phone; muted/vibrate/silent seats are not pressured or escalated as non-responders.

The fair per-task queue prioritizes never-asked/oldest tasks, permits one un-escalated open check-in per employee, and obeys the sender's hourly budget. The configured interval is a minimum repeat cooldown, **not a delivery SLA**. Pending ages, deadlines and coverage are reported; a capped or privacy-blocked queue never claims every assignment was checked on time. A response deadline starts only after an acknowledged durable post with actual phone eligibility, not while waiting in the queue. Its reply clock pauses durably while the assignee is off, vacationed, phone-blocked, inaccessible, or the watch is owner-disabled; resuming never rewrites the actual task commitment.

The check-in asks the current assignee to reply directly to that message with exactly:

- `On track` or `On track: concrete scope/reason`
- `New ETA: 2026-12-01T16:00:00Z | concrete reason`
- `Blocked: concrete reason`

Direct replies beginning `On track for ...` also retain that progress qualifier.
The qualifier remains in the correlated reply/ledger; it does not qualify runtime
acceptance or mark the work complete. A qualified report preserves the task's
status, blocker reason, dates and update timestamp; its acknowledgement says so.
The existing bare `On track` behavior is unchanged. Empty `On track:`/`On track for` fragments,
quoted status text and replies to a different prompt do not count as a report. A late reply keeps its
original deadline; accepting it does not backdate the response.

Only an unedited message stamped by the existing chat service with the current exact employee/session/generation binding and matching reply identity counts. A title, quoted text, manager reply, owner message or another session cannot answer for the assignee. Replies after the deadline still count. Later replies can unblock the same check-in; prior responses and reasons remain in history. The current canonical reply and room/bot policy are rechecked after an awaited audit and immediately before acknowledgement. An edited, deleted, rebound or revoked-source reply stays pending for reconciliation; it cannot change a plan or receive a false success acknowledgement.

The report is recorded and acknowledged even without Board-edit permission. Canonical task status/ETA changes require the assignee's existing effective `editBoardIssues` grant. A new ETA must extend the current date; the original commitment, prior date, response and reason remain in the private ledger/history and audit. Without permission the reported ETA remains a report and the canonical commitment is unchanged. No report marks actual work complete.

After no response, or an explicit blocker/planning follow-up, owner-enabled automation maintains one deterministic Board attention issue per task. The check-in ledger links task ID, check-in ID, prompt ID and attention ID; the Board card points to the prompt. It resolves the current reporting manager using the company's explicit reporting line/coordinator fallback and rechecks room membership before notifying. It does not leak task content to a manager outside that room, wake an off manager or grant access. A reply can resolve the attention item; only genuine completion of the original task completes actual work.

## Public issues

```json
{
  "version": 1,
  "type": "public-github-issues",
  "enabled": true,
  "botId": "github-issues",
  "roomId": "OWNER_SELECTED_ROOM",
  "owner": "ExampleOrg",
  "repo": "example",
  "intervalMinutes": 10
}
```

The source verifies that the configured repository is public, then polls its issues using anonymous HTTPS GETs, `ETag`/`If-None-Match` and a durable changed-item cursor. PR rows are excluded. New, updated, closed and observed reopened issues are reported; titles are sanitized untrusted text. A 304 is quiet. A scan uses at most ten fixed-origin pages/300 rows and rechecks the first-page fence before advancing. PR rows never produce notices, but their timestamps keep the observed scan fence current. More than30 changed issues in one batch or an unfinished scan is an explicit monitoring HOLD; nothing is silently truncated. No PAT is read or sent. Private/unreachable repositories need a separately configured read grant; this job does not invent one.

A failed, rate-limited, malformed or incomplete paginated read retains the cursor, applies bounded backoff and posts at most one monitoring-incomplete notice per hour. It never calls a failed poll an all-clear. Polling cannot reconstruct intermediate transitions that happened entirely between observations. Issue notices are visibility-only and do not wake providers.

## Durability and activation

Website-owned state files are `assignment-status-watch.json` and `public-issue-watch.json`. Mutating effects are preceded by fsynced attempt/quota records. Chat acknowledgements require the existing synchronous SQLite path; JSON debounce alone is refused. A restart reconciles uncertain posts only against one exact matching local bot message, never a quiet scan or blind repost. Unknown absent/ambiguous posts remain visible HOLDs. Board attention IDs are deterministic, so a committed Board write with a lost acknowledgement does not create a second ticket.

Terminal history is fsynced to `assignment-status-watch.json.history.jsonl` before old entries are compacted, retaining the latest task cooldown and unresolved attempts. Duplicate archive IDs after a crash are the same record, not new check-ins. Every state publication checks the serialized UTF-8 byte size against the same4MiB reader bound before any write; a known oversized update preserves the previous file and remains readable. State/history bounds fail closed without evicting unresolved evidence. An uncertain archive append latches the writer unavailable, and restart validates bounded JSONL framing before permitting another append or compaction; partial history and the live ledger are preserved for reconciliation. Corrupt state pauses only that bot; it is not silently reset. Preserve these files and the chat database during website updates.

Normal activation uses the verified owner's existing API session. A host operator may instead use these same typed stores only during a separately reviewed website-writer quiescence, under the existing external maintenance lock, with explicit owner provenance and retained backups. Do not edit live raw JSON, borrow owner cookies, promote a limited user or claim a source-only prototype is active. After activation verify the two enabled configurations, current tick/poll timestamps, actual bot messages/coverage, and unchanged existing routines.
