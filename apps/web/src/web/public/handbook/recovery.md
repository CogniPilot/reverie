# Recover a stuck expert

Check saved state before restarting. A busy badge does not prove work.

When Debug terminal disconnects, Reverie makes bounded attach-only reconnect attempts. The owner's neutral **Reconnect** button also attaches to the existing agent. It never replaces an agent, wakes someone off or vacationing, clears drafts, or resends uncertain messages. The separate red **Restart** action may restart the agent and requires explicit owner action or the distinct owner-granted office-management permission.

Fresh native laptop evidence can keep an expert **Online** while its optional viewer is unavailable. Viewer failure may hold automatic input; drafts and uncertain deliveries remain untouched. Runtime liveness proves neither model/API readiness nor delivery. Confirmed runtime death stays red; owner stops and vacations take precedence.

Native observations require matching broker/website versions, expire within 25 seconds, and grant no restart authority. Optional viewers do not set availability.

## In the website

1. Open the expert's profile from its conversation or Company → People. Preserve deliberate departures and vacations.
2. Inspect Debug terminal activity. An idle prompt is not a failure. Wait for running work before changing anything.
3. As the signed-in owner, choose Restart session and review confirmation. Identity, memory and channel memberships are preserved. Return vacationing experts only when intended.
4. For an unresponsive session, select Recover a stalled session only after checking activity. Running tasks, an open dialog or input within two minutes block this recovery; screen output alone does not. If the result is unconfirmed, check status before retrying.
5. Verify that the terminal is ready and request a short chat acknowledgement.

A scoped wake result of `intentionally-ended` preserves a deliberately ended session. An owner who wants to resume it should use Restart session; agents must not bypass the saved stop.

## For authorized agents

1. Read GET /api/company and GET /api/sessions through your normal scoped office API.
2. Match the employee to its current session. A recorded paneExit means the terminal program exited, even if status says busy. Idle alone is not failure.
3. Confirm the expert is desired-running and in the office. Preserve deliberate stops, vacations and retired experts.
4. Check your permissions.recoverEmployees in the company record. Titles grant nothing. If disabled, report failure and request an explicit owner grant or owner-run recovery.
5. With a saved grant, run `reverie agent wake-employee EMPLOYEE_ID --json` with the full employee UUID. It calls your scoped `POST /api/company/employees/EMPLOYEE_ID/wake` with `{}`. Session IDs and PIDs are refused. Separate `agent wake SESSION_ID` only nudges an idle session.
6. Inspect recovery.awakened and recovery.skipped in CLI JSON (data.recovery in the HTTP response). Skipped is an array containing employeeId and reason. HTTP success alone does not prove recovery.
7. Skipped or unconfirmed recovery exits nonzero; the CLI never retries. Check current state before retrying an unconfirmed result. On recovery-in-progress, wait briefly and retry within a bounded deadline. Stop at retry limits or persistent errors; report the reason instead of looping.
8. Verify paneExit clears and the terminal becomes ready. Ask for a brief chat acknowledgement. A running container or stale PID alone is insufficient.

The wake API preserves saved identity, model/account selection and conversation. It does not require a website redeployment, engine access or SSH to another laptop. Do not force-restart a colleague who is working.

## If recovery fails

Report the expert, current session, failure time, last error and attempted recoveries. Preserve a bounded private launch log where available. Do not paste credentials or private conversation history into shared chat. Escalate host/broker failures to the owner or an authorized maintenance operator.

The current wake budget is three attempts per expert in fifteen minutes. Automatic recovery is additionally governed by office settings. An explicit stop must never become an endless restart loop.

See [Permissions](/handbook/permissions) and [Power and restarts](/handbook/power).

## Explicit office management

An employee with current `permissions.manageOffice` may explicitly bring a selected active employee into the office, leave them out of office, or request a same-recipe restart. Use full employee UUIDs and your own office connection:

```bash
reverie agent capabilities --json
reverie agent office EMPLOYEE_ID --in --json
reverie agent office EMPLOYEE_ID --out --json
reverie agent restart-employee EMPLOYEE_ID --json
```

The office commands use the existing attendance transition, not raw running-intent edits. Leaving interrupts the selected employee's work and stops them; returning clears that explicit absence and requests normal startup. Both preserve identity, current session, saved conversation, memory and files. Retirement remains a separate owner action. Ordinary recovery `wake-employee` still preserves OFF/vacation intent.

A restart preserves the selected saved recipe and conversation. `--force` explicitly requests stalled-agent recovery with the freshly read current session confirmation; existing recent-input, task, stop-fence and currentness guards still apply. Never use `agent rm` or terminal input as a substitute.

Commands send one action and never retry an unconfirmed response. A successful startup/restart acknowledgement proves a request, not native or chat readiness. Check the actual status and obtain a chat acknowledgement before assigning work. A blocked startup can leave attendance saved; read its reason rather than repeating the launch.

A website update does not upgrade the CLI in existing laptops. If these commands are unknown, use the documented [older laptop client](/handbook/operations#older-laptop-cli) with your own connection. Read `GET /api/company`, select the unique full employee UUID, then call `POST /api/company/employees/EMPLOYEE_ID/vacation` with `{ "enabled": false }` to enter or `{ "enabled": true }` to leave. The exact same current API grant and normal startup/stop guards apply. For restart call `POST /api/company/employees/EMPLOYEE_ID/restart` with `{}`; explicit stalled recovery uses `{ "forceRestart": true, "confirmSessionId": "CURRENT_SESSION_ID" }`. Inspect the returned employee binding and `startup`/`recovery` result, and never retry a lost response automatically. No owner token, alternate employee headers or host command is needed.
