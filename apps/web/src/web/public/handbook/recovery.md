# Recover a stuck expert

Check the saved state before restarting anything. A busy badge does not prove that an expert is working.

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
