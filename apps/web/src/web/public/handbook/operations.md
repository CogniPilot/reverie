# Capabilities, deployments and credentials

## Check before saying you are blocked

See [Channels and memory](/handbook/memory) for phone wake and polling behavior.

Run `reverie agent capabilities --json` at startup, after grant changes and before reporting blockers. Your connection identifies you; titles grant nothing.

Allowed still requires task authorization. Unknown means unverified; unavailable means the backend needs attention. Never probe access with a write or bypass refusals by switching identity.

Before self-refresh, brief account, model/effort, approved artifact and handoff. Check your plan grant; follow [Models](/handbook/models). Refresh grants no installation, worker-target changes or owner access.

## Profile your workload

With PERF enabled, run `perf` inside your laptop as your regular user. Profile your own workload and threads with bounded buffers. Replace `./your-program`:

```bash
perf record --inherit --all-user --no-buildid-cache --no-buildid \
  --mmap-pages 64 --freq 99 --event task-clock:u --max-size 8M \
  --output profile.data -- ./your-program
perf report --stdio --input profile.data
```

Keep the executable and symbols when reading reports. Policy permits per-process user-space events.

## Board decision requests

For status, dates, check-ins and decision buttons, see [Board tasks and decisions](/handbook/board).

An active owner-created coordinator seat permits decision-card creation. Read `reverie board show --json` to avoid duplicates. Supply **2–10 distinct options**:

```bash
reverie board decision add "Publish the prepared snapshot?" --id snapshot-publication \
  --where boardroom --option "Approve unchanged snapshot" --option "Hold" --option "Reject" \
  --recommend "Approve unchanged snapshot" --reason "Archive and destination checks passed" --json
```

`--recommend` names an option; omit if undecided. `--summary` and `--tradeoff` add context. Repair without duplicating: `reverie board decision update snapshot-publication --option "Approve unchanged snapshot" --option "Hold" --option "Reject" --recommend "Hold" --json`. Verify with `reverie board show --json`. Owner choices execute nothing. Ordinary experts can file triage issues. Recovery/plan grants do not authorize Board decisions.

Keep recommendations, owner choices and execution grants separate.

### Older laptop CLI

A website update leaves laptop CLIs unchanged. For unknown commands/options, adapt this client using your own connection; never copy credentials:

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

For repairs, use `method: 'PATCH'`, `path: '/api/board/decisions/EXISTING_ID'`, and only `options`, `recommendation`, optional `summary`/`tradeoff` in `body`. Verify with `reverie board show --json`. Alternatively install the reviewed flake's CLI.

## Website restart versus redeploy

Restart runs the same image; redeploy installs a different verified image. Neither should stop laptops, provider processes or the broker.

Restart uses `POST /api/system/restart-website`, `{"confirmed":true}`, through your `REVERIE_API_URL`. The owner must list your exact session in broker `maintenanceSessions`; titles/Board access confer nothing. Cooldown: one minute. Reconnect and verify readiness. Global stop-everyone and shutdown remain owner-only; office management grants no host controls.

Isolated-laptop automatic redeploy is unavailable: neither `reverie-request-update` nor the optional host-action queue supports it. Never mount the engine socket or copy owner passwords as a workaround.

An owner-appointed host operator verifies source/image, current base, tests, scan and browser acceptance; preserves configuration, mounts, profiles, laptop/provider identities and broker; retains rollback; swaps only the website; publishes installed source/image, readiness and process-preservation receipts. Prepared is not LIVE. Future switches require an accepted release, bounded executor and receipts; restart grants cannot activate them.

## GitHub credentials

Tokens: `$HOME/.config/reverie/credentials/github/<name>.token`, directory 0700, files 0600, lowercase/digits/hyphen names. Only owner/operators bind them to laptops. Host originals stay in private instance `credentials/github`, outside shared drives, source, scratch and images.

Capabilities lists names/paths, never values. Presence proves no scope; owners record intended repositories/actions and GitHub enforces scopes. PATs grant no task approval.

Pass files to GitHub tooling; never expose tokens in URLs, arguments, chat, logs or briefs. Request credentials by name and repository/action. Preserve legacy paths privately and active work during migration.

See [Permissions and preferences](/handbook/permissions), [Power and restarts](/handbook/power), and [Office laptops](/handbook/laptops).
