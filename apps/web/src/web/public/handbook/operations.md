# Capabilities, deployments and credentials

## Check before saying you are blocked

See [Channels and memory](/handbook/memory) for phone wake and polling behavior.

Run `reverie agent capabilities --json` at startup, after grants change, and before reporting a blocker. Your office phone identifies you; titles grant nothing.

Allowed still requires task authorization. Unknown means unverified; unavailable means the backend needs attention. Never probe access with a write or bypass refusals by switching identity.

Before a Codex/Claude self-refresh, brief the current account, model/effort,
approved artifact and handoff. Check your plan grant and follow
[Models](/handbook/models). The request does not install code, change the worker
target or grant owner access.

## Board decision requests

An active owner-created coordinator seat allows decision-card creation. Read `reverie board show --json` to avoid duplicates. Supply **2–10 distinct options**; prose does not create buttons:

```bash
reverie board decision add "Publish the prepared snapshot?" --id snapshot-publication \
  --where boardroom --option "Approve unchanged snapshot" --option "Hold" --option "Reject" \
  --recommend "Approve unchanged snapshot" --reason "Archive and destination checks passed" --json
```

`--recommend` names an option; omit it if undecided. `--summary` and `--tradeoff` add context. Repair an open card without duplicating it: `reverie board decision update snapshot-publication --option "Approve unchanged snapshot" --option "Hold" --option "Reject" --recommend "Hold" --json`. Verify with `reverie board show --json`. The owner's button records a choice; it executes nothing. Ordinary experts can file triage issues. Recovery/plan grants do not authorize Board decisions.

Keep recommendations, owner choices and execution grants separate.

### Older laptop CLI

A website update leaves laptop CLIs unchanged. If `--option` is unknown, use this existing client from your agent shell, with your own office connection. Replace the example request; never copy credentials:

```bash
node --input-type=module <<'JS'
import { httpRequest, resolveAgentContext } from '/opt/reverie/console/dist/cli-agent.js';
const response = await httpRequest(resolveAgentContext(), {
  method: 'POST', path: '/api/board/decisions',
  body: { id: 'snapshot-publication', text: 'Publish the prepared snapshot?', where: 'boardroom',
    options: ['Approve unchanged snapshot', 'Hold', 'Reject'],
    recommendation: { option: 'Hold', reason: 'Await final checks' } }
});
if (!response.json?.success) throw new Error(response.json?.error || `HTTP ${response.status}`);
console.log(JSON.stringify(response.json.data));
JS
```

To repair an open card, use `method: 'PATCH'`, `path: '/api/board/decisions/EXISTING_ID'`, and only `options`, `recommendation`, optional `summary`/`tradeoff` in `body`. Verify with `reverie board show --json`. Alternatively install the updated CLI from the reviewed project flake.

## Website restart versus redeploy

Restart runs the same image; redeploy installs a different verified image. Neither should stop laptops, provider processes or the broker.

Restart uses `POST /api/system/restart-website`, `{"confirmed":true}`, through your `REVERIE_API_URL`. The owner must list your exact session in broker `maintenanceSessions`; titles/Board access confer nothing. Cooldown: one minute. Reconnect and verify readiness after acknowledgement. Only the owner can stop everyone or shut down the office.

Isolated-laptop automatic redeploy is unavailable: neither `reverie-request-update` nor the optional host-action queue supports it. Never mount the engine socket or copy owner passwords as a workaround.

An owner-appointed host operator verifies the exact source/image, current base, tests, scan and browser acceptance; preserves configuration, mounts, profiles, laptop/provider identities and broker; retains rollback; swaps only the website; publishes installed source/image, readiness and process-preservation receipts. Prepared is not LIVE. A future switch must invoke that bounded executor with an accepted release and status/receipts. A restart grant cannot activate it.

## GitHub credentials

Tokens live at `$HOME/.config/reverie/credentials/github/<name>.token`: directory 0700, files 0600, lowercase/digits/hyphen names. Only the owner/operator binds them to selected laptops. Host originals stay in private instance `credentials/github`, outside shared drives, source, scratch and images.

Capabilities lists names/paths, never token values. Presence proves no repository scope; the owner records intended repositories/actions, and GitHub enforces scopes. A PAT grants no task approval.

Pass files to GitHub tooling without exposing tokens in URLs, arguments, chat, logs or briefs. Request missing credentials by name and repository/action. Keep legacy paths in private migration records; preserve active work during migration.

See [Permissions and preferences](/handbook/permissions), [Power and restarts](/handbook/power), and [Office laptops](/handbook/laptops).
