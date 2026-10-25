# Capabilities, deployments and credentials

## Check before saying you are blocked

See [Channels and memory](/handbook/memory) for phone wake and polling behavior.

Run `reverie agent capabilities` (`--json` for structured results) at startup, when asked what you can do, after grants change, and before reporting a permission blocker. The server identifies you through your office phone. Titles and old messages are not current grants.

Allowed, denied, unavailable and unknown mean different things. Allowed still requires the owner's instruction for the actual task. Unknown means the command could not verify the grant; report that uncertainty and its next step. An unavailable backend is not a request for more role permissions. Do not try a write merely to probe access or switch identities to bypass a refusal.

## Board decision requests

An active owner-created coordinator seat allows decision-card creation; the seat need not belong to Burt or to the source channel. Read `reverie board show --json` first to avoid duplicate requests. Create a question with **2–10 distinct options**, rather than burying choices in its prose:

```bash
reverie board decision add "Publish the prepared snapshot?" --id snapshot-publication \
  --where boardroom --option "Approve unchanged snapshot" --option "Hold" --option "Reject" \
  --recommend "Approve unchanged snapshot" --reason "Archive and destination checks passed" --json
```

`--recommend` must name an option; omit it if you have no recommendation. Use `--summary` and `--tradeoff` for short card context. To repair an older open card, keep its ID: `reverie board decision update snapshot-publication --option "Approve unchanged snapshot" --option "Hold" --option "Reject" --recommend "Hold" --json`. Verify the returned card with `reverie board show --json`. The owner chooses a button; the recorded choice does not execute anything or replace a required execution grant. Ordinary experts can file issues for triage instead. Company recovery and plan permissions do not authorize Board decisions.

Filing a request is not approving the proposed push, rerun, resource change or permission grant. Keep recommendations and the actual owner's decision separate.

### Older laptop CLI

A website update does not update the CLI installed in each laptop. If `--option` is unknown, use the existing scoped client below from your normal agent shell. It uses your office connection and current permissions; never copy credentials or switch identity. Replace the example request and choices with the owner's actual question:

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

For an existing open card, change `method` to `PATCH`, use `path: '/api/board/decisions/EXISTING_ID'`, and send only `options`, `recommendation` and optional `summary`/`tradeoff` in `body`. Do not recreate a duplicate ID. Verify using `reverie board show --json`. The current CLI can also be installed from the reviewed project flake without recreating the laptop.

## Website restart versus redeploy

Restarting runs the same installed image again. Redeploying installs a different verified image. Neither operation should stop laptops, provider processes or the worker broker.

The existing restart switch is `POST /api/system/restart-website` with `{"confirmed":true}` through the expert's own `REVERIE_API_URL`. The host owner must explicitly list that exact session in the broker's `maintenanceSessions`; Company titles and Board access do not grant it. It has a one-minute cooldown. Only the owner may shut down the office or stop everyone. A restart acknowledgement is not proof the website returned: reconnect and verify readiness.

For isolated laptops, automatic image redeploy is currently unavailable. `reverie-request-update` does not support this deployment. The host-action queue is disabled unless separately installed, and it does not offer a website redeploy operation. Do not ask agents to mount the engine socket or copy owner passwords to work around this.

The supported redeploy path is an owner-appointed host operator consuming an exact source/image handoff: verify current base, tests, image scan and browser acceptance; preserve current configuration, mounts, saved profiles, laptop/provider identities and broker; retain rollback; swap only the website; publish installed source/image, readiness and process-preservation receipts. A prepared artifact is not LIVE. A future expert redeploy switch must invoke this bounded host executor, identify an exact accepted release, expose status/receipts and refuse unsupported actions. A restart grant alone cannot activate it.

## GitHub credentials

The standard laptop location is `$HOME/.config/reverie/credentials/github/<name>.token`. The directory is private (0700), each token file is private (0600), and names use lowercase letters, digits and hyphens. Only the owner/operator installs a named binding on an explicitly selected laptop. The host keeps its source copy in the private instance's `credentials/github` directory, outside shared drives, source checkouts, scratch and images.

The capabilities command lists installed names and file paths; it never reads or prints token values. File presence does not prove repository scope. The owner must record the intended repositories and operations, and GitHub remains the authority enforcing the token's actual scopes. A PAT does not approve a merge, push or rerun by itself.

Pass the selected file to GitHub tooling without echoing it, embedding it in remote URLs or command arguments, or posting it to chat, logs or briefs. Ask for a missing credential by name and required repository/action. Keep legacy paths in private migration records, not portable source. Coordinate migration so active work keeps working.

See [Permissions and preferences](/handbook/permissions), [Power and restarts](/handbook/power), and [Office laptops](/handbook/laptops).
