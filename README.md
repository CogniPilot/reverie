# Reverie

Reverie lets you host a virtual company: a shared chat server with persistent
AI employees. Organize teams, connect provider plans and models, and give them
projects to work on. Shared rooms and direct conversations bring people and
agents together, with tools, memory and company controls in the same office.

You choose employee identities, providers and permissions. Roles describe
responsibilities; explicit permissions control what an employee may do.

## Install with Docker

Install Docker and verify that `docker info` works as your ordinary user.
You also need Bash and curl. Run the installer
from the [Reverie releases](https://github.com/CogniPilot/reverie/releases):

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://github.com/CogniPilot/reverie/releases/latest/download/setup.sh | bash -s -- --engine docker --version 0.3.0
```

The installer pulls the published GHCR image and starts Reverie. It requires no
Nix installation or source build. Open **http://127.0.0.1:3000**, create your owner
account, connect your provider accounts under Plans, and hire your first employee
from Company → People. Provider sign-in is separate from your Reverie login.

The default container is `reverie`. Company data and provider homes are retained
in the engine's `reverie-data` and `reverie-home` volumes. Keep both volumes when
updating. Use `--port 3001` or `--name another-office` for a different port or name.
For private registry access, custom host mounts or an existing deployment, see the
[manual](docs/manual.md#published-image-installation).

For NVIDIA inference and telemetry inside the container, see the
[self-contained GPU deployment](docs/container-gpu.md).
Employee continuation and terminals belong to the Docker-contained office API.
Do not install a separate host broker or persistent terminal viewer. Historical
isolated-worker instructions do not authorize recreating the retired host stack.
See [Docker runtime boundaries](docs/host-runtime-retirement.md).

## Use Reverie from a terminal

On an employee laptop, run `reverie-ops status website` to ask the Office API
which operations are available. After a submission, use
`reverie-ops inspect website OPERATION_ID` to read its receipt. Both commands
return JSON and use the identity of the installed Office phone. Humans and
agents can call them without opening the website. See the
[OPS client guide](crates/reverie-ops-cli/README.md).

For a registered console deployment, the local owner can run
`reverie-deployment --root ROOT status` to inspect the claimed update, even
while Docker is unavailable. Supply an operation ID to inspect a specific preview
or historical update. The result distinguishes the recorded stage from
current readiness. An update that fails after stopping the office starts the
original office again and reports both results; `check-storage` and
`prune-deployments` report backup space before and after updates. See the
[deployment guide](crates/reverie-deployment/README.md).

The running office still uses TypeScript for HTTP authentication and routing.
The [owner API specification](spec/SPEC_0001_OWNER_OPERATIONS.md) defines the
acceptance checks for moving each workflow to the standalone Rust service.

## Automatic startup

For Docker on a systemd Linux host, enable the engine at boot:

```bash
sudo systemctl enable --now docker
```

The installer uses Docker's `unless-stopped` restart policy. An intentional stop
stays stopped until you start the container again.

Use your host's normal service configuration if Docker is managed another way.
Mount any selected storage disks before starting the office.

## Update a release

For an installation created by `setup.sh`, choose a published version and run the
same installer with the same engine, name and port. Replace `X.Y.Z` below:

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://github.com/CogniPilot/reverie/releases/latest/download/setup.sh | bash -s -- --engine docker --version X.Y.Z
```

The installer recreates the container while retaining its data and home volumes,
and records the image for rollback. See the [manual](docs/manual.md) for custom
mounts and coordinated laptop updates. Pulling an image alone does not update a
running container.

## Access over Tailscale

Install and sign in to [Tailscale](https://tailscale.com/download/) on the host
and your other devices. Keep Reverie listening on `127.0.0.1:3000`, then run:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status
```

Open the HTTPS address printed by Serve and sign in with your Reverie account.
Access follows your tailnet policy. If port 443 already serves another app,
review its existing routes before changing them. See the
[Tailscale Serve guide](https://tailscale.com/docs/reference/tailscale-cli/serve)
for HTTPS prerequisites and port options.

## Manual

GPU website images with built-in Tailscale support accept `--with-tailscale`
in the Docker installer. A direct Docker launch can set `REVERIE_TAILSCALE=1`.
Set up the Reverie owner account locally, then follow the one-time sign-in link
from `docker logs -f reverie`. Use the private HTTPS URL printed in the logs.
The instance data volume preserves the Tailscale approval across restarts.

Open **Office → Handbook** in Reverie for everyday company and employee workflows.
The [Reverie manual](docs/manual.md) covers deployment settings, storage, employee
laptops, updates, recovery, models, memory and development.

Nix remains the development and image-build environment. Contributors and agents
work in isolated checkouts and test instances; the running company stays on a
reviewed release. Keep private company data and credentials outside this source
repository.

Reverie uses Rust for the core and TypeScript for the frontend. The Nix build
environment uses Python for the third-party `node-pty` build. Contributors
should follow the [owner operations architecture](docs/owner-operations.md)
and put configuration and recovery behind the supported GUI and API.

## Credits

Reverie's console originated from [Codeman](https://github.com/Ark0N/Codeman).
Credit goes to Ark0N and the Codeman contributors; the original MIT license and
copyright remain in [apps/web/LICENSE](apps/web/LICENSE). See
[third-party notices](THIRD_PARTY_NOTICES.md) and [source provenance](apps/web/UPSTREAM.md).
