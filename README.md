# Reverie

Reverie is our independently maintained fork of [Codeman](https://github.com/Ark0N/Codeman),
with persistent agent identities, memory, dreaming and CTO-led orchestration.
The modified console source lives in `apps/console` and is built into the same
container as the agent runtime. Credit goes to Ark0N and the Codeman contributors;
the original MIT license and copyright remain in `apps/console/LICENSE`.
See [upstream notices](THIRD_PARTY_NOTICES.md) and
[source provenance](apps/console/UPSTREAM.md).

Use `reverie` inside the container. Existing `fleet` and `codeman` CLI aliases,
`REVERIE_*` settings, storage paths and `fleet-*` tools remain compatible.
The fork has no automatic upstream package update or synchronization process.

## What it is

A shareable agent workspace with persistent identities, private and project memory,
reflection, dreams and provider-independent handoffs. An instance selects its organizational role independently of its harness and
permissions. `kind: "agent"` provides a conversation-first local agent with chat
and bounded coding profiles; `kind: "cto"` retains the CTO template. Names, personal style, relationships, memories and instance credentials
are external data. No personal instance is included in this repository.

The current native runtime adapter uses OpenCode and its provider/model selection.
The portable memory CLI and skill also work from Codex, Claude Code and other CLIs.
Full automatic conversation ingestion for those other harnesses is future work;
installing the skill alone does not hook every completed turn automatically.
The implementation lives in `cto/`; generic specialist templates live in `experts/`.
Personal identities and their histories live in the ignored `local/` directory.
Existing SQLite history columns are read compatibly during migration.

## Setup

Two ways to run Reverie: the published container image (Docker or Podman), or
natively from a clone. Both end with the same first-login steps.
[docs/image.md](docs/image.md) and [docs/setup.md](docs/setup.md) have the details.

Plan about 15 minutes for a first run on a normal connection; the image pull is most
of it. Recreating later takes under 5 minutes because the data volume keeps the
sign-ins. Add a few minutes once for the GitHub steps (accepting the invitation,
creating a token).

### With Docker or Podman

While the repository is private, you need to be a collaborator on it with Read
access to the `reverie` package. The repository owner adds you as a collaborator,
then either grants you Read on the package or links the package to the repository
so collaborators inherit access. With the [GitHub CLI](https://cli.github.com/) and
your own GitHub account:

```bash
gh auth login
gh release download v0.1.1 --repo jgoppert/reverie --pattern setup.sh
```

Create a classic personal access token with only the `read:packages` scope
(GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)).
GHCR refuses fine-grained tokens. Sign in to the registry with the token on stdin,
so it never appears on the command line or in your shell history:

```bash
read -rs GHCR_TOKEN && printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USER --password-stdin; unset GHCR_TOKEN
```

Use `podman login` instead of `docker login` with Podman. Then start Reverie:

```bash
bash setup.sh
```

`setup.sh` pulls the release, starts a container named `reverie` with its data on
the `reverie-data` volume, and prints the address (`http://127.0.0.1:3000`, loopback
only). Print the console password the first start generated:

```bash
bash setup.sh --password
```

A new server requires owner sign-in from the start. Create the owner account once,
from this host shell (not from inside a Reverie session), and note the one-time
password it prints:

```bash
bash setup.sh --owner
```

Removing someone's access stops their future pulls only. An image they have
already pulled keeps working on their machine.

### Without Docker

Prerequisites: Node 22 or newer, Python 3.11 or newer, tmux, git, and a C++
compiler with make for the terminal module. With [Nix](https://nixos.org/download/),
one shell provides all of them:

```bash
nix shell nixpkgs#nodejs_22 nixpkgs#python3 nixpkgs#tmux nixpkgs#git nixpkgs#gcc nixpkgs#gnumake
```

Clone the repository (as a collaborator while it is private) and install the
memory runtime into its own virtual environment:

```bash
gh repo clone jgoppert/reverie && cd reverie
python3 -m venv ~/.local/share/reverie/python
~/.local/share/reverie/python/bin/pip install -e .
```

Build the console:

```bash
cd apps/console && npm ci && npm run build && cd ../..
```

The console keeps its state in `~/.fleet` unless `REVERIE_DATA_DIR` names another
directory; use the same value for every command below. Before the first start,
create the owner account with sign-in required, and note the one-time password it
prints:

```bash
node apps/console/dist/index.js owner bootstrap --username owner --enforce
```

Choose a console password, then start the console on loopback:

```bash
read -rs CODEMAN_PASSWORD && export CODEMAN_PASSWORD CODEMAN_USERNAME=owner REVERIE_MCP_MEMORY_PYTHON=$HOME/.local/share/reverie/python/bin/python3
node apps/console/dist/index.js web --host 127.0.0.1 --port 3000
```

[docs/setup.md](docs/setup.md) covers instance configuration, the native adapter
and memory skill, the runtime watcher and running the console as a service.

### First login

1. Open `http://127.0.0.1:3000`. The browser first asks for the console password
   (user `owner`, the password from `setup.sh --password` or the one you chose). It
   then shows the owner sign-in page: sign in as `owner` with the one-time password
   (valid 30 minutes; `reverie owner reset-password` from the host prints a new one)
   and choose your own password when asked. Both are required: the console
   password alone does not open owner pages, settings or plan accounts.
2. Add a plan: open the account menu in the header, choose **Add account**, name
   it and pick the provider (Claude or ChatGPT / Codex), then **Sign in** and follow
   the provider's link or code. **Plans** in the same menu shows each account's use.
3. Hire: until hiring by model ships, open `http://127.0.0.1:3000/?legacy=1`,
   choose the plan account and model in its Run controls and start a session,
   then open **Company** and hire that session. See
   [docs/image.md](docs/image.md#hiring-the-first-employee-interim-until-hire-by-model-lands).

To reach the console from another device, front it with an authenticated proxy or
tunnel such as `tailscale serve`; do not publish the port on all interfaces.


## Code and instance data

Keep the clone shareable and put private configuration outside it:

```text
~/git/reverie/                         code, container definition, skills, tests
local/                                    ignored link to machine-local instance data
local/assistant/                               personal identity, config and memories
~/.local/share/reverie/instances/shared/       separately configured shared instance
~/.local/share/reverie/engine/             persistent images and container layers
~/.local/share/reverie/home/               persistent agent home and native histories
~/git/scratch/reverie/                     disposable clones, worktrees, builds and caches
```

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

Install rootless Podman and its user-namespace prerequisites, then:

```bash
scripts/fleet-container build
scripts/fleet-container up
scripts/fleet-container exec bash
scripts/fleet-container exec python3 -m unittest discover -s tests
```

`REVERIE_PODMAN`, `REVERIE_SCRATCH`, `REVERIE_INSTANCE_DATA`, `REVERIE_CONTAINER_NAME`
and `REVERIE_IMAGE` can override local engine/path choices. After an image or mount change, choose a fresh
`REVERIE_CONTAINER_NAME`: `up` refuses to reuse mismatched containers and preserves
their sessions. The launcher requires a rootless engine. Image layers live under
`~/.local/share/reverie/engine`; builds, caches and temporary downloads go under
`~/git/scratch/reverie` (which may link to a larger disk). The development container mounts this source
checkout and its own scratch workspace, not a personal data directory or host engine
socket. Its CTO has passwordless container sudo, with a bounded capability set and
no privileged mode, host PID namespace or host root filesystem mount. The source,
scratch and selected private console-state binds are writable from the container.
No provider ports are exposed. Host-loopback access is off by default. For a trusted
personal development container, explicitly select
`REVERIE_ALLOW_HOST_LOOPBACK=1`, `REVERIE_CODEMAN_API_URL` and `REVERIE_MODEL_API_BASE`.
A shared deployment needs a separate authenticated Reverie instance and scoped
service connections. Do not give shared containers a route to the personal
instance's API. The development setup is not that shared access-control layer.

The CTO OpenCode installer defaults to broad command/edit/tool permissions when run
in this fleet container. Host execution retains the restricted initial profile.
Owner-controlled lifecycle decisions retain their own confirmation rules. Personal
self-revision cannot grant new host permissions. Containers share the host kernel;
use a VM for workloads requiring a stronger boundary.

The modified dashboard lives in `apps/console` and is built into the same image
as the memory runtime. The image uses this checkout's source; no upstream
package is downloaded. `reverie` is the product and CLI name. The original MIT
license and copyright are retained in `apps/console/LICENSE`, with source
provenance in `apps/console/UPSTREAM.md`.

For a recovered deployment, `scripts/reverie-recreate --dry-run` shows
the mounts before creation. The personal launcher mounts `~/.local/share/reverie/home`
at `/home/cto`, so native conversations and login configuration survive recreation.
Persistent instance handoffs belong under `/instances/example/runtime/handoffs`;
only disposable working copies belong under `/scratch`.

Inside the container, `reverie web --host 0.0.0.0 --port 3000` starts the console.
The default development launcher does not publish dashboard ports or start a
server. Choose the network exposure and authentication for the intended deployment;
existing host services and live sessions are untouched by an image build.
Console state persists by default at `~/.local/share/reverie/instances/development/console`,
mounted privately at `/home/cto/.fleet`. Override `REVERIE_INSTANCE_DATA` for a separate
instance before creating a new container. `REVERIE_DATA_DIR` configures other launches.
The monorepo contains `apps/console` (TypeScript/JavaScript), `cto` (the shared Python
memory runtime), `experts` (specialist templates), `docker`, `scripts`, shared skills
and their tests.

Open **Company** to register permanent employees with names, icons, positions and
expertise, invite experts into a room, and configure nightly research. Temporary
workers get random human names and icons and inherit their parent's single room;
explicit names and channel choices are preserved. Permanent employee identities
and curated research survive terminal session replacement through explicit rebind.

Nightly research is owner-configured, normally 60 minutes per employee, with an
IANA timezone and morning CTO briefing. Each cycle runs real tools in a separate
session/workspace, with persisted launch ownership and deadline enforcement.
Restart recovery never blindly repeats uncertain work. Reports and failures appear
in Company; imagination and unverified findings remain hypotheses. Existing private
memory and personal reflection retain their separate storage and lifecycle.

`nix/host.nix` provides an optional separate host account with rootless Podman,
private home and lingering. Import it and set `services.agentFleet.enable = true`.
Its default account is `fleet`; configure a personal deployment's name/home outside
this repository. It grants no host sudo, wheel membership or rootful Docker access.
Account activation and runtime cutover are separate from creating the container.

## Native adapter and memory skill

From an environment where this package and OpenCode are installed:

```bash
python3 -m cto.opencode --install /path/to/runtime \
  --instance /path/to/instance/config/instance.json --model provider/model
```

The installer copies the memory skill into `.agents/skills`, `.claude/skills` and
`.opencode/skills`, and records the explicit instance path in bridge metadata.
Read [fleet-memory](cto/skills/fleet-memory/SKILL.md) for the portable lookup/write
workflow. Use concise, verified project handoffs with source receipts. Private
notes stay private; dream ideas are unverified hypotheses until checked.

Runtime rules, current identity, core-value votes, vacation and publication proposals
remain readable. Existing personal self-models survive installation and model changes.
Full dream narratives are temporary; only bounded summaries and candidate ideas are
retained. Normal conversation/memory writes do not train or change model weights.
Optional training tools are not run by installation.

## Runtime selection and recovery

The [fleet-runtime skill](cto/skills/fleet-runtime/SKILL.md) covers Reverie backend
handoffs. Configure `examples/runtime-policy.json` outside the repository, with
actual enabled model IDs and a verified adopted case. The generic image installs
`fleet-backend`; configure Reverie's per-mode commands to `fleet-backend opencode`,
`fleet-backend codex` or `fleet-backend claude` after installing and signing in the
corresponding CLI. This wrapper reads the session's actual model setting and passes
it to the CLI; it does not infer model IDs from display names. Install a dedicated
instance workspace before launching a CTO runtime. `fleet-runtime switch` and
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

## CTO context preparation

The CTO curates each worker's short-term context: task, acceptance checks, constraints,
verified findings with sources, relevant files/tools and targeted memory queries.
Use [fleet-context](cto/skills/fleet-context/SKILL.md) and `cto_fleet` action `brief`.
The builder budgets against model context/output limits and occupied prompt space,
preserves complete required instructions, and reports omitted optional items. If the
essentials do not fit, split or shorten the task. It never injects private histories
or entire long-term stores. The CTO improves selection from worker feedback; model
quality and available evidence still limit how good a brief can be.

## Local GPU keep-alive

Users can select an OpenAI-compatible local GPU server, model ID, context limits and
fallback profile. Set the provider/model ID explicitly, for example `local_agent/MODEL_ID`. Model weights are installed/served by
the operator; this package does not download weights or allocate a GPU automatically.
A server may run on the host GPU or an authorized remote GPU. From a container, use
a reachable scoped endpoint instead of assuming `127.0.0.1` reaches the host.

Install the selected provider into a dedicated runtime workspace:

```bash
fleet-opencode --install /path/to/runtime --instance /path/to/config/instance.json \
  --model local_agent/MODEL_ID \
  --api-base http://MODEL_HOST:8080/v1 --context-window 32768 --output-tokens 4096
fleet-runtime --policy /path/to/config/runtime-policy.json local-health
fleet-runtime --policy /path/to/config/runtime-policy.json watch
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

Task scratch is owned separately from source, private data and shared caches:

```bash
fleet-workspaces create compiler-check
fleet-workspaces run compiler-check -- command-for-this-task
fleet-workspaces finish compiler-check --handoff 'Verified project handoff receipt'
fleet-workspaces clean compiler-check
fleet-workspaces clean compiler-check --apply
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
