# Owner-delegated team Goal management

In Company, open an employee's profile, choose Permissions and enable **Manage
team goals**. The same checkbox is available when hiring. It defaults to off;
job titles, plan management and recovery permissions do not imply this grant.
The owner can revoke it without changing the employee's other permissions.

This grants a currently authenticated employee access to the company's canonical
Goals: full read, creation for another current employee, and operational progress
before REVIEW. Transitions retain exact Goal/session generations, state/sequence
CAS and stable idempotency keys. Manager receipts identify the actual employee,
session and generation; they do not label that employee as the owner.

Use the existing `reverie agent goal list`, `read`, `create --input` and
`transition --input` commands. Read current bindings before preparing a command.
An uncertain response requires inspection with the same idempotency key, not an
automatic retry or a new operation.

Managers cannot decide REVIEW, close, cancel, reopen or adopt Goals, issue/revoke
grants, or attest unblockers. HOLD resume still needs an existing, exact,
owner-attested unblocker proof. Independent verification remains a separate
owner-issued VERIFY grant for another employee's exact current review gate.
Management does not permit self-verification. A VERIFY-only employee retains the
existing closed response and does not gain private Goal content.

This permission does **not** activate the Goal broker or supply a missing
authentication/custody adapter. The default remains unavailable without the
separately configured, accepted host-to-server proof boundary. Shared credentials,
parent-session headers, service tokens and a checkbox are not identity proofs.

Provider-native goal loops, including a provider's `/goal` and its PAUSED state,
are separate. This feature neither resumes those loops nor sends terminal input,
wakes employees or changes their office attendance. Canonical Goals use HOLD,
not PAUSED. Deployment and an authenticated installed acceptance check remain
separate from source tests.
