# Reverie

Reverie is our independently maintained fork of [Codeman](https://github.com/Ark0N/Codeman),
with persistent agent identities, memory, dreaming and permission-based orchestration.
The modified console source lives in `apps/web` and is built into the same
container as the agent runtime. Credit goes to Ark0N and the Codeman contributors;
the original MIT license and copyright remain in `apps/web/LICENSE`.
See [upstream notices](THIRD_PARTY_NOTICES.md) and
[source provenance](apps/web/UPSTREAM.md).

Use `reverie` inside the container, `REVERIE_*` settings, and `reverie-*` tools.
The fork has no automatic upstream package update or synchronization process.

## What it is

A shareable agent workspace with persistent identities, private and project memory,
reflection, dreams and provider-independent handoffs. Every expert is a generic AI
agent with its own memory. CTO, COO and specialist titles describe organizational
roles; explicit permissions control tools and orchestration independently of titles.
Chat and coding are working modes of the same agent. Names, personal style, relationships, memories and instance credentials
are external data. No personal instance is included in this repository.

The current native runtime adapter uses OpenCode and its provider/model selection.
The portable memory CLI and skill also work from Codex, Claude Code and other CLIs.
Full automatic conversation ingestion for those other harnesses is future work;
installing the skill alone does not hook every completed turn automatically.
The implementation lives in `python/reverie/`; generic specialist templates live in `python/experts/`.
Personal identities and their histories live in the ignored `local/` directory.
Existing SQLite history columns are read compatibly during migration.

## Setup

### Run the published image (no Nix installation)

Use the prebuilt image at `ghcr.io/jgoppert/reverie:0.2.0` with Docker or Podman.
The host needs no Nix installation, source checkout, Node or Python. Download
`setup.sh` from the matching GitHub release, then run:

```bash
bash setup.sh --engine docker --version 0.2.0
```

Follow [the image guide](docs/image.md#quick-start) for prerequisites, private
registry login, direct container commands and browser owner-account setup.
For a machine without registry access, use the release's
[offline bundle](docs/INSTALL.md), which also needs no Nix installation.
Release assets and image tags become available after release CI completes.

### Build from source with Nix

[Install Nix](https://nixos.org/download/) if needed, then clone Reverie
(collaborator access is required while the repository is private):

```bash
gh repo clone jgoppert/reverie
cd reverie
export NIX_CONFIG="experimental-features = nix-command flakes"
```

## Default local deployment

From a clone, start the default Docker deployment with:

~~~bash
nix run .#start
~~~

This builds the current flake image and creates an editable ~/reverie/deployment.json
only on first run. Company state and provider logins live under
~/reverie/companies/default; working projects live in ~/reverie/workspace.
~/reverie/scratch is the default scratch drive. To use a second disk, point that
directory at an owner-selected mount or symlink before starting. You can edit the validated paths, port, container name,
memory limit and process limit in deployment.json. Existing containers are retained;
a changed deployment requires a new container name rather than silent replacement.

Source code, host configuration and host update requests are not exposed by default.
To explicitly expose a chosen project on the first launch:

~~~bash
nix run .#start -- --source /absolute/path/to/project
~~~

The ordinary workspace is /reverie_workspace. To explicitly grant a project and
add a link to it from that workspace:

~~~bash
nix run .#start -- --project reverie=/absolute/path/to/reverie
~~~

This mounts only the selected directory at /projects/reverie and creates
/reverie_workspace/reverie pointing to it. No source checkout is mounted by default.
A link alone cannot expose host files through Docker; the explicit mount grants
access. Removing the link does not revoke the mount; recreate the container without
that project grant to revoke access. The older --source option mounts its selected
project at /workspace without changing the default working directory.
Add --allow-updates only when you also configure the owner-controlled host updater;
this exposes only its request directory, not a Docker socket or host configuration.
Use --root /absolute/path to select another contained deployment directory.

**Native:** install the complete application and start it:

```bash
nix profile install .#default
reverie service install --host 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000` and follow [first login](docs/setup.md#first-login)
to create the owner account and sign in to your provider plans. The default
container deployment requires a running Docker engine. Its image is built by Nix;
there is no separate Dockerfile build. For manual image loading or published
images, see [image installation](docs/image.md).

## Agent workstations

For a deployment running autonomous agents, use a separate worker container for
each session. Think of these as the experts' office laptops: each has its own
running tools, private home and restart boundary. Explicit project mounts are
shared drives; the console is separate office infrastructure.

Nix builds both images and the host broker. CPU is uncapped by default: an idle
laptop lends its capacity to a busy one. The default MVP admits laptops against
an owner-sized memory budget, with a 4 GiB hard ceiling per laptop and no swap.
The console has its own 8 GiB ceiling; the host retains additional headroom.
Use `prepare --budget-mode pool` with the NixOS module for a shared memory pool
with reclaim pressure and a hard aggregate ceiling, allowing idle laptops to lend memory too. Each workstation has an init process and a hard task limit
(threads count), so orphaned or runaway tools cannot fill the console's process
table. Optional per-worker CPU and memory caps remain available.

Prepare a migration of the current bind-mounted Docker deployment with:

```bash
nix run .#isolate -- prepare
```

This builds and scans matching server and worker images and writes an owner-only
configuration at `~/reverie/runtime/worker-isolation/broker.json`. The default
admission mode starts an ordinary owner user service without administrator activation.
Pooled mode also writes `nixos.nix`: include it in the host configuration and activate
it normally first. Then run:

```bash
nix run .#isolate -- activate
```

Activation verifies the enforced host budget and broker before stopping anything,
backs up private state, preserves mounts, accounts and vacation choices, and
retains the previous stopped container for rollback. Only experts already marked
as desired-running and not on vacation are eligible to resume. An absent broker
or host resource budget fails closed; agents never fall back into the console.
Later image changes use this paired preparation/activation workflow too.

Laptops keep their terminal programs running through website restarts. Reconnecting
attaches to the same terminal; it does not launch the command again. A host-side
watchdog stops all laptop containers after **10 minutes without a reachable office
API**. Its outage timestamp survives broker restarts. Once the API returns, the
normal desired-running and vacation rules apply again.

Settings → System → Office power distinguishes three actions:

- **Stop Reverie** stops all agents and laptops before stopping the website.
- **Stop all agents** stops laptops and keeps the website open.
- **Restart website** keeps laptop programs running; chat briefly goes offline.

Stop actions record intentional employee stops before executing them. Maintenance
restarts leave running intent alone. Only the owner may stop everyone. An owner
may explicitly grant a maintainer session with `prepare --maintainer-session UUID`;
that agent may call `POST /api/system/restart-website` with `{ "confirmed": true }`.
The host checks the fixed caller identity, permits only website restart, and limits
restarts to one per minute. A title grants no restart or shutdown permission.

The host broker grants fixed mounts and accepts only worker execution requests;
neither the console nor workers receive the engine socket. Workers cannot reach
the broker socket. The console's private company state is not mounted into laptops. Only selected provider
accounts and explicit project drives are mounted. Each laptop has its own internet
bridge, private home and labelled scratch directory; there is no peer laptop LAN.
The office HTTP connection fixes caller identity and retains existing API permissions.
Automatic scratch pruning is deferred; use leased workspaces and save a handoff
before releasing disposable task data. Project mounts retain their current trust model: sharing a writable directory still permits edits to its files. Use
separate Git worktrees for concurrent source changes. Resource isolation is not a
promise that shared writable files are protected from another expert.

## Office handbook

Open **Handbook** in the conversation sidebar, or `/handbook`, for searchable
pages shared by humans and agents. The same packaged Markdown is available through
`GET /api/handbook` and `GET /api/handbook/:slug` using the normal scoped office API.
Expert context includes these lookup pointers and the current recovery grant.
The handbook explains procedures; it does not grant permissions. Source pages live
in `apps/web/src/web/public/handbook/` and ship in the native flake package.

Company preference checkboxes save each field immediately with confirmation or an
error. This includes Sleep, Dream and explicit recovery/plan grants; a failed or
unconfirmed request cannot silently appear saved. Older deployments with a
Save preferences button still require that button until updated.

## Access over Tailscale

Install and sign in to [Tailscale](https://tailscale.com/download/) on the host and
on devices that need access. Keep Reverie listening at `http://127.0.0.1:3000`,
then run on the host:

~~~bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status
~~~

Open the HTTPS address printed by Serve, such as
`https://your-machine.your-tailnet.ts.net`. Port 443 needs no port suffix. Serve
manages HTTPS and background mode survives host restarts; enable tailnet HTTPS
certificates if Tailscale prompts you. Sign in with your Reverie owner account.
Access remains limited to devices and people permitted by your Tailscale policy.
See the [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

If port 443 already serves another app, review `tailscale serve status` before
replacing it. To deliberately discard all old Serve/Funnel routes, run
`sudo tailscale serve reset`, then run the Serve command above. To keep other apps,
choose an unused HTTPS port instead and include it in the address.

For embassies, enter this same HTTPS origin in **Embassies → Invite a company →
Shareable HTTPS address**. The other company must be able to reach this host through
Tailscale, using a permitted tailnet membership or shared device. An invitation
still requires explicit pairing approval; it does not grant company administration.
Serve is private to Tailscale; public internet hosting through Funnel is a separate
choice.

## Code and instance data

Keep the clone shareable. REVERIE_ROOT defaults to ~/reverie; setting it selects another
contained deployment root. The default layout is:

~~~text
~/git/reverie/                         source checkout
~/reverie/deployment.json              editable deployment settings
~/reverie/companies/default/data/      console, identity and memory state
~/reverie/companies/default/home/      agent tool settings and provider logins
~/reverie/workspace/                   working projects and cases
~/reverie/runtime/                     host helpers, controls and engine state
~/reverie/scratch/                     scratch drive (directory or owner-selected mount)
~~~


Copy `examples/shared.json` to the chosen instance's `config/instance.json`,
then set its identity, initial commitments, persona and data directory. Relative
paths resolve against the configuration file. Missing or invalid explicit config
fails rather than selecting another instance. Generic defaults do not inspect the
original persona's caches or history. Keep private directories
mode 0700 and credentials outside the repository and image.

The shared deployment gets its own configuration, data, credentials and sessions.
Mount only the selected instance. Copy reviewed project findings into it; never
mount a personal memory database or raw chat/transcript directories into a shared
container. A hidden DM or an addressed public message is not an isolation boundary.

A model switch retains the same memory database, self-model, plan, lifecycle ballots
and skill access. Save a compact task handoff before switching. Recent remembered
exchanges are bounded using the selected model's context/output limits and prompt
occupancy, with space reserved for tools. The portable byte estimate is conservative;
provider tokenizers and the harness still enforce the final context window.

## Reverie container

The Nix-built image contains the console and memory runtime. Provider CLIs are
installed on first start into persistent private tool storage; they are not
distributed in the image. Native and container installations use the same pinned
installer. Provider sign-in and company state survive container replacement.
Managed sessions wait for their provider installation to finish before launching,
and suppress the provider's automatic update prompt. To retry an installation
after a network failure, run `reverie-install-clis` in a Reverie terminal.

Open **Company → People +** or **Hire** to choose an expert's role, customize
their profile and review the hire. Choose a provider plan or local model profile;
model and effort use its defaults. Change Plan, Harness, Model and Effort later
from the expert's runtime settings. Each expert has a persistent identity and
memory. Choose an illustrated avatar, upload a photo, or use initials.
Explicit permissions control orchestration independently of organizational titles.
Drag an expert onto another plan to request a move, including between Codex and
Claude. The destination selects its native harness; changing providers uses that
provider's model and effort defaults. The expert prepares a handoff and approves
the request before the replacement starts; its source stops only after the
replacement is ready.

Grant **Move own plan** or **Manage team plans** on an employee's Company card
or during hiring. A CTO with Manage team plans can read team plan usage and request
moves for other experts; a title alone grants no permission. From an authenticated
expert session, use `reverie plans --json` for account IDs, then
`reverie agent plan-move request <account-id> [--employee <employee-id>]`.
The affected expert still supplies its own handoff and runs the approval command.
These permissions grant no account login, account deletion or general session creation.
They default off and currently apply to single-company deployments; multi-user
account delegation remains disabled.

Kokoro speech runs locally with Nix-managed Python, ONNX Runtime and espeak-ng.
The web launcher starts it in the background; its pinned, checksum-verified models
are downloaded on first start into the instance's `data/voice/kokoro` directory.
Once ready, its voices appear in **Expert profile → Voice**, with **Play sample**
to preview them. A saved choice applies across devices and remains independent
of pronouns. Models and saved selections survive image updates.
Set `REVERIE_KOKORO_ENABLED=0` to disable the bundled service, or set
`REVERIE_KOKORO_URL` to use an existing compatible service. For a standalone native
service, run `nix run .#kokoro`; it listens only on `127.0.0.1:8091`.

Nightly research is owner-configured, normally 60 minutes per employee, with an
IANA timezone and morning coordinator briefing. Each cycle runs real tools in a separate
session/workspace, with persisted launch ownership and deadline enforcement.
Restart recovery never blindly repeats uncertain work. Reports and failures appear
in Company; imagination and unverified findings remain hypotheses. Existing private
memory and personal reflection retain their separate storage and lifecycle.

See [setup and operations](docs/setup.md) for recovery, source mounts, reproducible
image updates and optional development-container workflows.

## Native adapter and memory skill

From an environment where this package and OpenCode are installed:

```bash
python3 -m reverie.opencode --install /path/to/runtime \
  --instance /path/to/instance/config/instance.json --model provider/model
```

The installer copies the memory skill into `.agents/skills`, `.claude/skills` and
`.opencode/skills`, and records the explicit instance path in bridge metadata.
Read [reverie-memory](python/reverie/skills/reverie-memory/SKILL.md) for the portable lookup/write
workflow. Use concise, verified project handoffs with source receipts. Private
notes stay private; dream ideas are unverified hypotheses until checked.

Runtime rules, current identity, core-value votes, vacation and publication proposals
remain readable. Existing personal self-models survive installation and model changes.
Full dream narratives are temporary; only bounded summaries and candidate ideas are
retained. Normal conversation/memory writes do not train or change model weights.
Optional training tools are not run by installation.

## Runtime selection and recovery

The [reverie-runtime skill](python/reverie/skills/reverie-runtime/SKILL.md) covers Reverie backend
handoffs. Configure `examples/runtime-policy.json` outside the repository, with
actual enabled model IDs and a verified adopted case. The generic image installs
`reverie-backend`; configure Reverie's per-mode commands to `reverie-backend opencode`,
`reverie-backend codex` or `reverie-backend claude` after installing and signing in the
corresponding CLI. This wrapper reads the session's actual model setting and passes
it to the CLI; it does not infer model IDs from display names. Install a dedicated
instance workspace before launching an agent runtime. `reverie-runtime switch` and
`reboot` save a handoff and provision a candidate via Reverie's API. Verification,
role transfer and activation precede closing the original session. The Python
`watch` command provisions a local fallback after abnormal exits, with bounded
retries. It does not treat idle, clean exit, approval dialogs or deliberate removal
as reasons to keep spawning. This is not enabled automatically on existing agents.

The current native adapter automatically records OpenCode turns. Other CLI
adapters can use the same memory and handoff skill, but full automatic recording
and uninterrupted chat-role transfer still need integration. Reverie currently
reserves appointing a room coordinator for the owner; this code respects that gate.
Keep the watcher and its authority-bearing state outside writable agent mounts.

Model weights remain fixed. There is no nightly backpropagation or automatic
fine-tuning. Reflection and dreaming write external agent memory. Optional legacy
training tools are retained for compatibility but are outside the runtime workflow.

## Agent context preparation

An owner-appointed coordinator with explicit orchestration permission curates each
worker's short-term context: task, acceptance checks, constraints,
verified findings with sources, relevant files/tools and targeted memory queries.
Use [reverie-context](python/reverie/skills/reverie-context/SKILL.md) and `reverie_tools` action `brief`.
The builder budgets against model context/output limits and occupied prompt space,
preserves complete required instructions, and reports omitted optional items. If the
essentials do not fit, split or shorten the task. It never injects private histories
or entire long-term stores. The coordinator improves selection from worker feedback; model
quality and available evidence still limit how good a brief can be.

## Local GPU keep-alive

Users can select an OpenAI-compatible local GPU server, model ID, context limits and
fallback profile. Set the provider/model ID explicitly, for example `local_agent/MODEL_ID`. Model weights are installed/served by
the operator; this package does not download weights or allocate a GPU automatically.
A server may run on the host GPU or an authorized remote GPU. From a container, use
a reachable scoped endpoint instead of assuming `127.0.0.1` reaches the host.

Install the selected provider into a dedicated runtime workspace:

```bash
reverie-opencode --install /path/to/runtime --instance /path/to/config/instance.json \
  --model local_agent/MODEL_ID \
  --api-base http://MODEL_HOST:8080/v1 --context-window 32768 --output-tokens 4096
reverie-runtime --policy /path/to/config/runtime-policy.json local-health
reverie-runtime --policy /path/to/config/runtime-policy.json watch
```

Configure `keep_alive` in the external policy using `examples/runtime-policy.json`:
`model_api_url` must match that provider's endpoint and `model_id` its model.
`api_key_env` optionally names a credential environment variable; credentials are
never copied into the image or policy. `poll_seconds`, `probe_timeout_seconds` and
`max_recoveries` bound monitoring and recovery. The lightweight Python watcher probes
the model catalogue before creating a fallback; an unavailable/unregistered model
blocks creation without spending the restart budget. A catalogue entry is a preflight
check, not proof that inference/GPU allocation will succeed.

The local recovery agent reads the saved identity/plan/handoff, checks actual provider
usage and availability, then requests an enabled stronger model or continues locally.
It must inspect real usage responses; an enabled profile alone proves no remaining
subscription capacity. Recovery currently creates a candidate: verified memory/chat
handoff and activation still precede closing the old session. Provisioning the GPU
server at boot and running the watcher as a supervised service are operator setup.
The watcher never restarts the host machine or overrides an owner pause/stop.

## Task cleanup

Scratch directories can stay on separate drives. For native tasks, select the
location with `reverie-workspaces --root /path/on/drive create TASK`; set `TMPDIR`
and compiler cache variables per task as needed.

The optional development container accepts any number of additional scratch mounts:

```bash
scripts/reverie-container --scratch-mount /path/on/drive2 /scratch2 --scratch-mount /path/on/drive3 /scratch3 up
```

Sources must already exist. Destinations are `/scratch2`, `/scratch3`, and so on.
The default `/scratch` location still uses `REVERIE_WORKSPACE`. Reusing a container
requires exactly the same image and mounts; choose a new container name after a
mount change. The launcher does not mount physical drives or pool their storage.

Task scratch is owned separately from source, private data and shared caches:

```bash
reverie-workspaces create compiler-check
reverie-workspaces run compiler-check -- command-for-this-task
reverie-workspaces finish compiler-check --handoff 'Verified project handoff receipt'
reverie-workspaces clean compiler-check
reverie-workspaces clean compiler-check --apply
```

`clean` previews by default. The admin can apply cleanup after a task is complete,
its handoff is saved and its lease is released. A live lease blocks cleanup; source
checkouts, unowned roots and symlink task roots are refused. A symlink inside scratch
is removed without following it. Failed/unfinished work, project repositories,
memories and shared caches are not part of this cleanup. This is a task-level tool;
it does not perform global Docker/Podman pruning or run a nightly scheduler.

## Validation

```bash
python3 -m unittest discover -s tests
node --test tests/test_opencode_plugin.mjs
```

Tests cover memory, reflection, dreams, deliberate values, scope isolation, lifecycle
archives, model continuity, context budgeting and scratch leases. Test histories are
synthetic fixtures. Keep migration receipts and operational logs in private instance
storage; do not commit them with the shareable source.

## Proposed memory design

GitHub displays the [memory explorer HTML source](docs/memory-explorer.html) rather than running it.
To view the standalone demo, run this from the repository root:

```bash
python3 -m http.server 8000 --bind 127.0.0.1 --directory docs
```

Then [open the memory explorer](http://127.0.0.1:8000/memory-explorer.html).
Stop the preview server with Ctrl+C when finished.

The demo contains only synthetic records and shows a self-organizing tag tree, typed
associations, human-inspired consolidation and bounded task-context selection.
This is a design visualization; the production store has not yet adopted this
richer schema or tag reorganization. No live or private memory is loaded.

## Supervising a deployed console

For an existing deployment named `reverie-live`, install
`systemd/reverie.service` into `~/.config/systemd/user/`, alongside the engine
service and trusted launcher described above. Adjust the repository/launcher paths
and container name for your installation, then run
`systemctl --user daemon-reload` and `systemctl --user enable --now reverie.service`.
The service restarts on both errors and clean exits, including an update-triggered
shutdown. Use `systemctl --user stop reverie.service` for a deliberate stop.
User lingering must be enabled for startup without an interactive login.
This starts the existing container; applying a newly built image requires a
separate deployment step. Native agent sessions may need to be resumed after a
container restart; console availability alone does not establish agent recovery.

See [runtime configuration](docs/runtime-configuration.md) for neutral model defaults, profile section keys, and required user-service environment files.
