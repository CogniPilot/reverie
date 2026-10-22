# Reverie setup and operations

Detailed setup, runtime and operations notes. The [README](../README.md) has the overview.

A shareable agent workspace with persistent identities, private and project memory,
reflection, dreams and provider-independent handoffs. Every expert is a generic AI
agent with its own memory. CTO, COO and specialist titles are organizational roles;
explicit permissions control tools and orchestration independently of titles. Names, personal style, relationships, memories and instance credentials
are external data. No personal instance is included in this repository.

The current native runtime adapter uses OpenCode and its provider/model selection.
The portable memory CLI and skill also work from Codex, Claude Code and other CLIs.
Full automatic conversation ingestion for those other harnesses is future work;
installing the skill alone does not hook every completed turn automatically.
The implementation lives in `python/reverie/`; generic specialist templates live in `python/experts/`.
Personal identities and their histories live in the ignored `local/` directory.
Existing SQLite history columns are read compatibly during migration.

## Default local deployment

From a clone, start the default Docker deployment with:

~~~bash
nix run .#start
~~~

This builds the current flake image and creates an editable ~/reverie/deployment.json
only on first run. Company state and provider logins live under
~/reverie/companies/default; working projects live in ~/reverie/workspace.
~/reverie/scratch links to ~/scratch/reverie by default, so large builds and agent
scratch use the large disk. You can edit the validated paths, port, container name,
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

## Keeping the runtime available

The native command `reverie service install --host 127.0.0.1 --port 3000` installs
a user service that runs the Nix launcher, including its runtime environment and
instance initialization. The host supervisor restarts a killed console process;
`systemctl --user stop reverie-web.service` remains an explicit stop. User services
start at login unless the host administrator separately enables lingering.

For Docker, use `--restart unless-stopped` so the engine restarts the container
after an unexpected exit. An explicit container stop remains stopped. Host-level
supervision brings the console back. In **Company → People**, the owner can turn
**Automatic recovery** off or choose **Wake after a crash**. Only the selected
expert wakes automatically. Without a selection, a sole top-level expert is used;
multiple top-level experts require a choice. The selected expert can wake reports
only with an explicit recovery grant. Persistent data stays in the instance directory
or Docker volumes across process restarts and container recreation.

The Docker command and setup script preserve two named volumes: reverie-data at
/instances for console and configured instance state, and reverie-home at
/home/agent for agent tool configuration, provider authorization and conversation
history using default home/XDG paths. Keep both volumes when recreating or upgrading.
They begin as fresh container storage; no host configuration is mounted or restored.

## Requesting a reproducible image update

When the owner enables the host update service, agents can edit the mounted source
at `/workspace` and run `reverie-request-update`. This touches only
`/run/reverie-control/update.request`; it supplies no shell command and needs no
Docker socket inside the container.

The owner-configured host action runs the Nix-store copy of `reverie-update`,
rebuilds the fixed `REVERIE_REPO` with `.#dockerImage`, and replaces the running
container only after the build succeeds. Existing instance/home volumes, source
and scratch mounts, read-only flags and explicit environment overrides survive.
A failed replacement restores the previous container. A container stopped before
or during the build stays stopped. Host logs report completion or rollback.

The host service fixes `REVERIE_REPO`, `REVERIE_CONTAINER_NAME`, `REVERIE_PORT` and
`REVERIE_CONTROL_DIR`; request-file contents are never executed. Builds and
intermediate files stay under `$HOME/scratch/reverie/update`. The host requires
Nix, Docker, jq, curl and flock. This workflow neither manages provider credentials
nor restores private backups.

## First login

Open http://127.0.0.1:3000. On a new installation, choose **Create account**, enter
your username and a new password, and confirm the password. No temporary password
or host command is needed. Your display name is separate from your login username.

On later visits, sign in with the username and password you chose. If two-factor
authentication is enabled, complete its authenticator or recovery-code step.
The generated internal console credential is for runtime communication; you do not
need it to create your account or sign in.

### Advanced host recovery

An installation that has already recorded an owner never reopens public account
creation, even if its account file is missing. Restore the account from a backup
or use the host administration tools. Manual initial provisioning remains available
with `reverie owner bootstrap --username owner --enforce` (for Docker, prefix it
with `docker exec -it reverie`). Its temporary password is for this manual recovery
path only.

For a lost owner password, run the following from the host, then use the newly
printed one-time password and choose a new permanent password:

~~~bash
docker exec -it reverie reverie owner reset-password
# Native installation: reverie owner reset-password
~~~

Password reset preserves the account and its two-factor settings. It ends existing
owner sessions. Do not replace an existing account just to sign in.

## Provider plans and hiring

Claude Code, Codex and OpenCode are installed automatically on first start into
private persistent tools storage, rather than bundled in the image. The console
opens while installation runs. If installation is interrupted or offline, retry
reverie-install-clis once the network is available.

In **Plans**, add an account and choose **Sign in** to authorize the provider.
The provider account is separate from your Reverie owner login.

Then open **Company → People → Hire**. Enter the expert's name and role, select a
plan or configured local endpoint, model, harness, and supported effort level.
Hiring creates a fresh session and registers the expert; no pre-existing terminal
session or legacy screen is required. Provider/model choices are independent of
the harness. Only effort choices supported by that harness are offered.

See [image operations](image.md) for registry access and offline installation, and
[hiring an expert](image.md#hiring-an-expert) for the image workflow.

## Multiple scratch drives

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
~/reverie/scratch/                     symlink to ~/scratch/reverie by default
~~~


Copy `examples/shared-instance.json` to the chosen instance's `config/instance.json`,
then set its identity, initial commitments, persona and data directory. Relative
paths resolve against the configuration file. Missing or invalid explicit config
fails rather than selecting another instance. Generic defaults do not inspect the
original persona's caches or history. Keep private directories
mode 0700 and credentials outside the repository and image.

A shared deployment gets its own configuration, data, credentials and sessions.
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
scripts/reverie-container build
scripts/reverie-container up
scripts/reverie-container exec bash
scripts/reverie-container exec python3 -m unittest discover -s tests
```

`REVERIE_PODMAN`, `REVERIE_SCRATCH`, `REVERIE_ENGINE_ROOT`, `REVERIE_INSTANCE_DATA`, `REVERIE_CONTAINER_NAME`
and `REVERIE_IMAGE` can override local engine/path choices. After an image or mount change, choose a fresh
`REVERIE_CONTAINER_NAME`: `up` refuses to reuse mismatched containers and preserves
their sessions. The launcher requires a rootless engine. Image layers live under
`~/reverie/runtime/engine`; builds, caches and temporary downloads go under
`$HOME/scratch/reverie`. `REVERIE_TMPDIR` and `REVERIE_WORKSPACE` override the
temporary directory and development workspace. The development container mounts this source
checkout and its own scratch workspace, not a personal data directory or host engine
socket. Its Linux runtime account has passwordless container sudo, with a bounded capability set and
no privileged mode, host PID namespace or host root filesystem mount. The source,
scratch and selected private console-state binds are writable from the container.
No provider ports are exposed. Host-loopback access is off by default. For a trusted
personal development container, explicitly select
`REVERIE_ALLOW_HOST_LOOPBACK=1`, `REVERIE_API_URL` and `REVERIE_MODEL_API_BASE`.
A shared deployment needs a separate authenticated Reverie instance and scoped
service connections. Do not give shared-instance containers a route to the personal
instance's API. The development setup is not that shared access-control layer.

Agents share the same tool gates. The console owns explicit role permissions;
CTO and COO titles do not grant broader command, edit or delegation access.
Owner-controlled lifecycle decisions retain their own confirmation rules. Personal
self-revision cannot grant new host permissions. Containers share the host kernel;
use a VM for workloads requiring a stronger boundary.

The modified dashboard lives in `apps/web` and is built into the same image
as the memory runtime. The image uses this checkout's source; no upstream
package is downloaded. `reverie` is the product and CLI name. The original MIT
license and copyright are retained in `apps/web/LICENSE`, with source
provenance in `apps/web/UPSTREAM.md`.

For a recovered personal deployment, `scripts/reverie-recreate --dry-run` shows
the mounts before creation. The personal launcher mounts `~/reverie/companies/default/home`
at `/home/agent`, so native conversations and login configuration survive recreation.
Persistent instance handoffs belong under `/instances/example/runtime/handoffs`;
only disposable working copies belong under `/scratch`.

Inside the container, `reverie web --host 0.0.0.0 --port 3000` starts the console.
The default development launcher does not publish dashboard ports or start a
server. Choose the network exposure and authentication for the intended deployment;
existing host services and live sessions are untouched by an image build.
Console state persists by default at `~/reverie/companies/development/data/console`,
mounted privately at `/home/agent/.reverie`. Override `REVERIE_INSTANCE_DATA` for a separate
instance before creating a new container. `REVERIE_DATA_DIR` configures other launches.
The monorepo contains `apps/web` (TypeScript/JavaScript), `python/reverie` (the shared Python
memory runtime), `python/experts` (specialist templates), `docker`, `scripts`, shared skills
and their tests.

Open **Company** to register permanent employees with names, icons, positions and
expertise, invite experts into a room, and configure nightly research. Temporary
workers get random human names and icons and inherit their parent's single room;
explicit names and channel choices are preserved. Permanent employee identities
and curated research survive terminal session replacement through explicit rebind.

Nightly research is owner-configured, normally 60 minutes per employee, with an
IANA timezone and morning coordinator briefing. Each cycle runs real tools in a separate
session/workspace, with persisted launch ownership and deadline enforcement.
Restart recovery never blindly repeats uncertain work. Reports and failures appear
in Company; imagination and unverified findings remain hypotheses. Existing private
memory and personal reflection retain their separate storage and lifecycle.

See [console setup](../apps/web/README.md) for running the dashboard on its own.

`nix/host.nix` provides an optional separate host account with rootless Podman,
private home and lingering. Import it and set `services.reverie.enable = true`.
Its default account name is `reverie`; configure a personal deployment's name/home outside
this repository. It grants no host sudo, wheel membership or rootful Docker access.
Account activation and runtime cutover are separate from creating the container.

## Native adapter and memory skill

From an environment where this package and OpenCode are installed:

```bash
python3 -m reverie.opencode --install /path/to/runtime \
  --instance /path/to/instance/config/instance.json --model provider/model
```

The installer copies the memory skill into `.agents/skills`, `.claude/skills` and
`.opencode/skills`, and records the explicit instance path in bridge metadata.
Read [reverie-memory](../python/reverie/skills/reverie-memory/SKILL.md) for the portable lookup/write
workflow. Use concise, verified project handoffs with source receipts. Private
notes stay private; dream ideas are unverified hypotheses until checked.

Runtime rules, current identity, core-value votes, vacation and publication proposals
remain readable. Existing personal self-models survive installation and model changes.
Dreams are off by default: set `REVERIE_DREAMS_PER_SLEEP=1` (and enable `dreaming`
on the expert profile) to turn them on. Full dream narratives are temporary; only
bounded summaries and candidate ideas are
retained. Normal conversation/memory writes do not train or change model weights.
Optional training tools are not run by installation.

## Runtime selection and recovery

The [reverie-runtime skill](../python/reverie/skills/reverie-runtime/SKILL.md) covers Reverie backend
handoffs. Configure `examples/runtime-policy.json` outside the repository, with
actual enabled model IDs and a verified adopted case. The generic image installs
`reverie-backend`; configure Reverie's per-mode commands to `reverie-backend opencode`,
`reverie-backend codex` or `reverie-backend claude` after installing and signing in the
corresponding CLI. This wrapper reads the session's actual model setting and passes
it to the CLI; it does not infer model IDs from display names. Install a dedicated
instance workspace before launching an agent runtime. `reverie-runtime switch` and
`reboot` save a handoff and provision a candidate via the Reverie console API. Verification,
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
Use [reverie-context](../python/reverie/skills/reverie-context/SKILL.md) and `reverie_tools` action `brief`.
The builder budgets against model context/output limits and occupied prompt space,
preserves complete required instructions, and reports omitted optional items. If the
essentials do not fit, split or shorten the task. It never injects private histories
or entire long-term stores. The coordinator improves selection from worker feedback; model
quality and available evidence still limit how good a brief can be.

## Local GPU keep-alive

Users can select an OpenAI-compatible local GPU server, model ID, context limits and
fallback profile. The default is `local_agent/qwen3.8-27b`, a Qwen local
model; select your own model ID in configuration. Model weights are installed/served by
the operator; this package does not download weights or allocate a GPU automatically.
A server may run on the host GPU or an authorized remote GPU. From a container, use
a reachable scoped endpoint instead of assuming `127.0.0.1` reaches the host.

Install the selected provider into a dedicated runtime workspace:

```bash
reverie-opencode --install /path/to/runtime --instance /path/to/config/instance.json \
  --model local_agent/qwen3.8-27b \
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

GitHub displays the [memory explorer HTML source](memory-explorer.html) rather than running it.
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

See [runtime configuration](runtime-configuration.md) for neutral model defaults, profile section keys, and required user-service environment files.
