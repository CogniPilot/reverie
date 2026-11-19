---
name: reverie-runtime
description: Change a Reverie expert's runtime or recover a disconnected session while preserving identity, memory and unfinished work.
---

Save unfinished work, decisions, receipts, blockers and the next action in the
expert's existing workspace or memory. Keep the handoff private and concise.

Use Company and Plans to change an expert's runtime. The owner selects the
provider account, harness, model and effort. Provider sign-in and billing stay
under the account owner's control.

An authorized expert can obtain the selected account ID from `reverie plans
--json` and submit a request with `reverie agent plan-move request ACCOUNT_ID`.
The affected expert approves it with `reverie agent plan-move approve REQUEST_ID
--handoff-file FILE`. Keep the handoff file outside shared source and use the
same request ID to inspect an uncertain outcome. The server checks the current
grant, releases the old runtime when it is safe, then verifies the replacement
and delivers the handoff.

For a disconnected expert, inspect the current Company status and use the
owner's Wake or Restart session action as appropriate. Verify that the same
expert has its existing memory, workspace and rooms. Report an uncertain or
permission-denied operation to the owner with its receipt. Approval and sign-in
prompts require the responsible human's explicit action.
