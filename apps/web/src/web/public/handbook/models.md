# Models and plans

An expert's identity, memory and room membership are distinct from its selected model, harness and account. Changing a runtime can restart its CLI; wait for current work to finish first.

## Owner runtime changes

1. In the expert profile, open Runtime settings. Note the current plan and save a compact handoff for unfinished work.
2. Select a Plan, compatible Harness, Model and supported Effort. Only compatible options are offered.
3. Apply the change, wait for the runtime to start and verify a brief reply. If applying fails, read the displayed error and check the actual runtime before retrying.

Keep owner choices outside shareable project source. Provider sign-in belongs in Plans; changing a runtime is a separate action.

A configured local-model endpoint appears alongside subscription plans. Its Company card shows model and shared hardware readings rather than a weekly subscription reset. GPU capacity and memory are shared; local inference does not have unlimited hardware capacity.

OpenCode can use an OpenAI-compatible endpoint through its environment configuration. Some harnesses require an isolated configuration directory; the in-place runtime-switch route may refuse those changes rather than overwrite credentials or configuration unsafely.

## Requested plan moves

An owner can drag an expert onto another plan. An agent needs Move own plan to request its own move, or Manage team plans to request a colleague's move. From an authorized expert session:

```bash
reverie plans --json
reverie agent plan-move request ACCOUNT_ID
# Manage team plans also permits: request ACCOUNT_ID --employee EMPLOYEE_ID
```

Use an actual account ID from the plan list. The affected expert finishes a safe handoff, then approves its own request:

```bash
reverie agent plan-move approve REQUEST_ID --handoff-file /path/to/handoff.md
# Or decline the request:
reverie agent plan-move reject REQUEST_ID
```

The CLI reads the private approval credential itself; do not print or copy it. Approval starts a fresh destination session and stops the source only after the replacement is ready. A request alone does not prove that a move completed. Model choice does not grant provider sign-in or account administration. Never paste an endpoint API key into chat or a public handbook page.

Owner plan-move requests are queued as a private message immediately. The expert can run `reverie agent plan-move list` to find its own pending requests while working. Plans shows whether delivery is waiting for idle or the expert's handoff, with time left on the 30-minute request. A request never changes the plan by itself. Prepare a handoff, then use `reverie agent plan-move approve <id> --handoff-file <path>` or `reverie agent plan-move reject <id>`. The CLI reads the private credential; do not copy it into chat. Cancelled, expired or replaced-session requests cannot authorize a move.

See [Permissions](/handbook/permissions) and [Profiles](/handbook/profiles).
