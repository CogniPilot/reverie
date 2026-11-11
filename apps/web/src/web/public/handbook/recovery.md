# Recover a stuck expert

A busy badge does not prove work. Check the current employee, session and activity. Preserve deliberate stops, vacations, retirement, unique work and uncertain deliveries.

## Inspect first

Open the employee profile and Debug terminal. An idle prompt is not failure. Fresh native laptop evidence can show an expert Online while its optional viewer is unavailable; observations expire within 25 seconds. Runtime liveness and HTTP success do not prove model readiness or chat delivery.

The signed-in owner can use **Status** for bounded diagnostics and **Reconnect** to attach the existing server viewer. Browser terminal attachment is a separate operation. Neither reconnect replaces the provider, wakes someone off, clears drafts or resends uncertain input.

**Restart session** preserves identity, memory and channel membership. Explicitly return an absent employee first. **Recover a stalled session** requires checking activity: running tasks, dialogs and input within two minutes block it; redraws alone do not. Verify readiness and request a brief chat acknowledgement afterward.

## Delegated wake and viewer repair

Use your own scoped connection. Read `GET /api/company` and `GET /api/sessions`; match the current employee/session binding. Titles grant nothing. Check `reverie agent capabilities --json` before reporting a permission blocker.

The explicit `permissions.recoverEmployees` grant permits:

```bash
reverie agent wake-employee EMPLOYEE_ID --json
reverie agent viewer-status EMPLOYEE_ID --json
reverie agent reconnect-viewer EMPLOYEE_ID --json
```

Use the full employee UUID. Separate `agent wake SESSION_ID` only nudges an idle session. Ordinary wake preserves stopped/vacation intent and saved runtime; inspect `data.recovery.awakened` and `data.recovery.skipped`. Its budget is three attempts per employee in fifteen minutes, subject to office settings.

For isolated laptops, automatic and manual wake use fresh provider health rather than the optional viewer's PID. A healthy provider is preserved; `native-health-unconfirmed` blocks a new start until health can be checked. Repair a disconnected viewer separately. Recovery permission and the original employee/session generation remain checked while a request waits.

`start-unconfirmed` means a start may already have happened. The wake CLI exits with an error, preserves that result in JSON, and makes no automatic retry. Check the employee's current state before another recovery attempt.

Viewer repair requires compatible website, broker and laptop CLI versions, authenticated native office proof, current permissions, exact session/generation and fresh provider health. Missing proof fails closed. Copied parent headers and borrowed owner cookies grant no authority.

Viewer status returns `state`, `reason`, `attempts` and `retryAfterMs` under `reconnect`, distinguishing health, stale binding, move/lifecycle holds, readiness and backoff. Reading status starts nothing. Repair never restarts the provider, replays Enter or blindly clears working state. After an unconfirmed response, inspect status; never automatically repeat it.

## Office attendance and restarts

The separate **Manage office attendance and restarts** grant defaults off:

```bash
reverie agent office EMPLOYEE_ID --in --json
reverie agent office EMPLOYEE_ID --out --json
reverie agent restart-employee EMPLOYEE_ID --json
```

Enter requests startup; Leave interrupts and records absence. Restart preserves the current saved runtime and conversation. These commands grant no profile edits, hiring, account administration or host maintenance. Check `--help`; never substitute `agent rm` or terminal input. Website updates do not update existing laptop CLIs; use your own [older-client connection](/handbook/operations) when needed.

## Interrupted plan moves

**Manage team plans** permits colleague transfers; **Move own plan** permits self transfers only. Ordinary moves require the affected expert's approval. Explicit forced recovery requires native office proof and can interrupt active work:

```bash
reverie agent plan-move force ACCOUNT_ID --employee EMPLOYEE_ID --id STABLE_ID --handoff-file DURABLE_PATH --json
reverie agent plan-move recovery-status STABLE_ID --employee EMPLOYEE_ID --json
reverie agent plan-move recover-existing STABLE_ID --employee EMPLOYEE_ID --json
reverie agent plan-move cancel-recovery STABLE_ID --employee EMPLOYEE_ID --json
```

Preserve work first and write a truthful handoff with durable recovery locations. Forced recovery does not pretend expert approval. A returned journal or 202 is not completion. Inspect the same operation after a lost reply; never invent another ID to bypass a hold.

Adoption verifies the existing destination and stopped source without launching or replaying a handoff. Self-recovery waits for idle: end your turn, then inspect status. Cancellation applies only while waiting. Active, ambiguous, resource and unconfirmed moves remain held; unknown deliveries and stop fences remain authoritative.

Report persistent failures with employee, current session, time, error and attempted recoveries. Keep credentials and private history out of shared chat. See [Permissions](/handbook/permissions) and [Power and restarts](/handbook/power).
