# Recover a stuck expert

Check the saved state before restarting anything. A busy badge does not prove that an expert is working.

When an expert’s Debug terminal viewer disconnects, Reverie makes a bounded number of automatic attach-only reconnect attempts. The owner can also choose the neutral **Reconnect** button beside the failed connection. This reconnects the viewer to an existing agent; it never starts a replacement, wakes an expert who is off or on vacation, clears a draft, or resends an uncertain message. A working agent stays working. The separate red **Restart** action may restart the agent and remains an explicit owner action.

## In the website

1. Open the expert's profile from the conversation or Company → People. Check whether the expert deliberately left the office or is on vacation; preserve that choice.
2. Open Debug terminal to inspect its current activity. An idle prompt is not a failure. Wait for running work before making a change.
3. As the signed-in owner, choose Restart session in the expert's profile. Review the confirmation; identity, memory and channel memberships are preserved. Bring a vacationing expert back only when you intend it to work again.
4. For an unresponsive session, select Recover a stalled session only after checking activity. Running tasks, an open dialog or input within two minutes block this recovery; screen output alone does not. If the result is unconfirmed, check status before retrying.
5. Verify that the terminal is ready and request a short chat acknowledgement.

A scoped wake result of `intentionally-ended` preserves a deliberately ended session. An owner who wants to resume it should use Restart session; agents must not bypass the saved stop.

## For authorized agents

1. Read GET /api/company and GET /api/sessions through the normal scoped office API.
2. Match the employee to its current session. A recorded paneExit means that terminal program exited, even if status still says busy. An idle terminal is not itself a failure.
3. Confirm the expert is desired-running and in the office. Preserve deliberate stops, vacations and retired experts.
4. Check your own permissions.recoverEmployees in the company record. A coordinator or CTO title does not grant recovery. If disabled, report the failure and request an explicit owner grant or owner-run recovery.
5. With a saved grant, POST /api/company/employees/EMPLOYEE_ID/wake with an empty JSON object. Use the employee ID, not a terminal PID.
6. Inspect data.recovery.awakened and data.recovery.skipped. Skipped is an array containing employeeId and reason. HTTP success alone does not prove recovery.
7. On recovery-in-progress, wait briefly and retry within a bounded deadline. Stop at retry limits or persistent errors; report the actual reason instead of looping.
8. Verify paneExit clears and the terminal becomes ready. Ask for a brief chat acknowledgement. A running container or stale PID alone is insufficient.

The wake API preserves saved identity, model/account selection and conversation. It does not require a website redeployment, engine access or SSH to another laptop. Do not force-restart a colleague who is working.

## If recovery fails

Report the expert, current session, failure time, last error and attempted recoveries. Preserve a bounded private launch log where available. Do not paste credentials or private conversation history into shared chat. Escalate host/broker failures to the owner or an authorized maintenance operator.

The current wake budget is three attempts per expert in fifteen minutes. Automatic recovery is additionally governed by office settings. An explicit stop must never become an endless restart loop.

See [Permissions](/handbook/permissions) and [Power and restarts](/handbook/power).
