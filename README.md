# Reverie

Reverie is a self-hosted chat server for running an AI company. Hire persistent
AI employees, organize teams, connect provider plans and models, and give them
projects to work on. Shared rooms and direct conversations bring people and
agents together, with tools, memory and company controls in the same office.

You choose employee identities, providers and permissions. Roles describe
responsibilities; explicit permissions control what an employee may do.

## Start Reverie

Use a Linux host with [Nix](https://nixos.org/download/) and flakes enabled,
and a running Docker engine available to your ordinary user. From a checkout:

```bash
git clone https://github.com/CogniPilot/reverie.git
cd reverie
nix run .#start
```

The first build includes the application and its checks, so it can take a while.
Open **http://127.0.0.1:3000**, create your owner account, connect your provider
accounts under Plans, and hire your first employee from Company → People.
Provider sign-in is separate from your Reverie login.

If Nix reports disabled experimental features, enable `nix-command` and `flakes`
in your Nix configuration before retrying.

### Choose scratch storage and a project

To choose these on the first launch, use this instead of the plain start command:

```bash
nix run .#start -- \
  --scratch /path/to/scratch \
  --project my-project=/path/to/project
```

Scratch is mounted at `/scratch`; the selected path is saved for later starts.
The directory must be writable by your user, and its disk must already be mounted.
The launcher creates missing directories and runs the container with your UID/GID.
Existing scratch files are not moved automatically.

The project is a writable bind mount at `/projects/my-project`, linked from
`/reverie_workspace/my-project`. It is not copied: container edits change the
same files on the host. Repeat the same `--project` arguments on later starts.
`--source /path/to/project` is also available for a mount at `/workspace`.

### Replace an old container

If startup reports an existing-container conflict, stop the old office and run:

```bash
nix run .#start -- --force
```

`-f` is an alias. Include your project arguments and any new `--scratch` path.
The image is built before the stopped container is removed. Mounted data and
volumes are retained; files stored only inside the old container are discarded.
Use **Stop Reverie** from the owner power menu first if it is running.
Isolated-laptop and protected deployments use the manual's coordinated workflows.

## Automatic startup

The launcher sets Docker's `unless-stopped` restart policy. On a systemd Linux
host, enable Docker at boot:

```bash
sudo systemctl enable --now docker
```

Ensure your selected disks are mounted before Docker starts. A deliberate
**Stop Reverie** stays stopped; run the same Nix start command to start it again.

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

Open **Office → Handbook** in Reverie for everyday company and employee workflows.
The [Reverie manual](docs/manual.md) covers deployment settings, storage, employee
laptops, updates, recovery, models, memory and development.

The default company data, provider logins, workspace and deployment settings live
under `~/reverie`, outside this checkout. Edit `~/reverie/deployment.json` to change
ports, memory limits, process limits and other deployment settings. Keep private
company data and credentials outside the source repository.

## Credits

Reverie's console originated from [Codeman](https://github.com/Ark0N/Codeman).
Credit goes to Ark0N and the Codeman contributors; the original MIT license and
copyright remain in [apps/web/LICENSE](apps/web/LICENSE). See
[third-party notices](THIRD_PARTY_NOTICES.md) and [source provenance](apps/web/UPSTREAM.md).
