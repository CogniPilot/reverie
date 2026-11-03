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

The CLI reads the private approval credential itself; do not print or copy it. Approval reserves the replacement metadata, verifies source cleanup, then starts and checks the replacement before delivering the handoff. A request alone does not prove that a move completed. Model choice does not grant provider sign-in or account administration. Never paste an endpoint API key into chat or a public handbook page.

## Transfer a stuck expert

When an expert cannot complete the normal approval workflow, an owner can force
the transfer. An agent with **Manage team plans**, or **Move own plan** for itself,
can use the same guarded recovery through its authenticated native office connection:

```bash
reverie agent plan-move force ACCOUNT_ID --employee EMPLOYEE_ID --id STABLE_OPERATION_ID --handoff-file /path/to/handoff.md --json
```

Preserve work and write a truthful handoff with durable recovery locations. This
can interrupt the expert without pretending approval. Permissions and bindings
are rechecked. A returned operation is not completion: inspect its existing
journal after a lost reply. Retain uncertain deliveries and stop fences; never
bypass a hold with another ID. See [Recovery](/handbook/recovery) for commands.

## Refresh your current runtime

A Codex or Claude expert with Move own plan or Manage team plans can request
its own fresh conversation on the current account:

```bash
reverie agent plan-move request CURRENT_ACCOUNT_ID --restart --id STABLE_REQUEST_ID
reverie agent plan-move approve STABLE_REQUEST_ID --handoff-file /path/to/handoff.md
```

Use the actual account ID from `reverie plans --json`. `--restart` records
`runtime-refresh`, refusing another expert/account or an ordinary same-account
move. Refresh preserves account, model, effort, directory and permissions while
clearing provider resume linkage. Changed settings or grants refuse it. Approve
with a safe handoff while running; do not quit first. Inspect lost responses and
retain recovery holds.

Refresh grants no installation, worker-image change or stopped/vacation wake.
Hands, custom endpoints, OpenCode, remote and Docker-case sessions are unsupported.

Check `reverie agent plan-move request --help`: website updates do not update
laptop CLIs. Older clients can use their existing scoped office connection;
operator examples are in the repository manual. Never borrow an owner cookie or
another identity.

See [Permissions](/handbook/permissions) and [Profiles](/handbook/profiles).
