# Running Reverie from the published image

Each release publishes a container image to `ghcr.io/jgoppert/reverie`, tagged with its
version (`0.2.0`, `0.2`, `latest`). It holds the console, the memory runtime, the generic
expert templates and a provider-tool installer. Provider CLIs are installed in private
persistent storage on first start, not bundled in the image. It holds no instance:
no identities, memories, rooms, credentials or model weights. The first start creates an
empty instance on a volume.

## Quick start

Running the published image requires **no Nix installation or source checkout**.
Nix builds the image in CI; its runtime is already inside the image. The host
needs a working Docker Engine or Podman, Bash and a browser. Node and Python
are not host requirements. Use a host matching the release image's architecture
(the v0.2.0 Debian instructions target x86_64).

On Debian 12, install Docker as your normal user with sudo permission:

```bash
sudo apt-get update
sudo apt-get install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and log back in before continuing, then check `docker info` succeeds.
Docker users on other systems can use the
[Docker installation instructions](https://docs.docker.com/engine/install/).

### Download the setup script

Download `setup.sh` from the **v0.2.0 GitHub release**, or use the copy from its
extracted offline bundle. Wait for release CI to finish publishing the assets
and GHCR tag before installing. With the optional GitHub CLI:

```bash
gh release download v0.2.0 --repo jgoppert/reverie --pattern setup.sh
```

Private release downloads require signing in with `gh auth login` using an
account with repository access. This download login and the registry login
below are separate. A public release also permits a browser download without
the GitHub CLI.

### Log in if the GHCR package is private

Public GHCR images can be pulled anonymously. For a private package, your GitHub
account must have read access to that package. Use a personal access token
**(classic)** with `read:packages`; authorize organization SSO if required.
The token is entered silently and passed through stdin:

```bash
read -r -p 'GitHub username: ' GHCR_USER
read -r -s -p 'GitHub token (classic, read:packages): ' GHCR_TOKEN
printf '\n'
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username "$GHCR_USER" --password-stdin
unset GHCR_TOKEN
```

See [GitHub's registry authentication guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-with-a-personal-access-token).

### Start the pinned release

In the directory containing `setup.sh`, run:

```bash
bash setup.sh --engine docker --version 0.2.0
```

For Podman, use `podman login` above and `--engine podman` here. Use the same
engine and normal user for login and installation. The version pins the pull to
`ghcr.io/jgoppert/reverie:0.2.0`; `latest` and `0.2` can move with later releases.

`setup.sh` pulls the release, starts one container named `reverie` with a data volume
`reverie-data` mounted at `/instances` and a home volume `reverie-home` mounted at
`/home/agent`, and prints the address. The console listens on
127.0.0.1:3000 only. Open `http://127.0.0.1:3000` and choose **Create account**
on a fresh instance. Choose your owner username and permanent password in the
browser; an existing instance uses its existing owner sign-in. The internal
credential printed by `setup.sh --password` is not your browser owner password.
Provider sign-in is a separate step after owner setup.

For a remote machine, run this on your own computer and open the same local URL:

```bash
ssh -L 3000:127.0.0.1:3000 YOUR_USER@YOUR_SERVER
```

For advanced host provisioning, `bash setup.sh --engine docker --owner`
prints a one-time password for username `owner`. Use `/owner/login` and change
that temporary password when prompted. This is an alternative to browser
account creation, not a required first-install step.

For an existing account, keep its credentials. If needed, issue a new one-time
password from the host:

~~~bash
docker exec -it reverie reverie owner reset-password
~~~

This preserves two-factor settings and ends existing owner sessions.

Options: `--version X.Y.Z`, `--port N`, `--name NAME` (a second server on the same machine),
`--dry-run`.

The home volume preserves agent tool configuration, provider authorization and conversation
history that use their normal home or XDG paths. The data volume preserves console state,
instance configuration and explicitly located memories. Keep both volumes when upgrading or
recreating the container; neither imports configuration from the host. A custom name
uses NAME-data and NAME-home. Removing either volume permanently removes its records.

### Direct Docker commands

For a manual start, use these commands instead of the setup-script start:

```bash
docker pull ghcr.io/jgoppert/reverie:0.2.0
docker run --detach --name reverie --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --mount type=volume,src=reverie-data,dst=/instances \
  --mount type=volume,src=reverie-home,dst=/home/agent \
  ghcr.io/jgoppert/reverie:0.2.0
docker logs reverie
docker image inspect ghcr.io/jgoppert/reverie:0.2.0 --format '{{json .RepoDigests}}'
```

The direct command returns before the application is ready; follow its logs and
open the browser once startup completes. It uses the same container name and
volumes as the setup route, so choose one route. The setup script additionally
waits for HTTP readiness and records upgrade/rollback history; a manual run
does not populate that history. Compare the reported image digest with the
release's published digest when provided.

## Upgrade and rollback

For a release bundle with a local image archive, follow
[offline installation](offline-install.md). `setup.sh --offline [PATH]` loads
the archive (default `./reverie-image.tar`), checks the requested image tag and
starts its local image ID with `--pull=never`. Use the image name and version
from the bundle's `IMAGE-REF.txt`; no registry login or host Nix is required.

```bash
bash setup.sh --engine docker --version X.Y.Z
bash setup.sh --engine docker --rollback
```

Replace `X.Y.Z` with the next published version. The first start of a new release
backs up console state on the volume; rollback returns to the previous release
and its backed-up state.

The container is replaced; both named volumes are kept. `setup.sh` records each release it started
in `~/reverie/runtime/setup/<name>.versions` by image digest, so a rollback returns to the exact
bytes that ran before.

## What the image does at start

`/usr/local/bin/reverie-start` runs before the console on every start:

1. creates the instance directory on the volume (`REVERIE_DATA`, default `/instances/default`)
   and the temporary directory;
2. on the first start after an image change (`REVERIE_VERSION` differs from the volume's
   record), writes a tar backup of `console/` under `backups/` before the console migrates
   its files;
3. retains a private internal console credential in owner-password (mode 0600); on
   a fresh installation the browser offers **Create account**, where you choose your
   username and permanent password. Existing installations use ordinary owner sign-in;
4. starts the installer for Claude Code, Codex and OpenCode in the background, writing
   private persistent tools storage; offline failures leave the console available.
   REVERIE_INSTALL_CLIS can select providers or none. Retry with reverie-install-clis.
   It points the default Claude and Codex profiles at
   `accounts/claude` and `accounts/codex` on the volume so a recreate keeps a sign-in;
5. runs the given command, by default `reverie web --host 0.0.0.0 --port 3000`.

Any other command runs after the same preparation. The development and personal
launchers (`scripts/reverie-container`, `scripts/reverie-recreate`) bypass it with
`--entrypoint /usr/bin/env`, because they mount their own instance and workspace.

## Hiring an expert

In **Plans**, add a provider account and select **Sign in**. Provider authorization
is independent of the Reverie owner account. First-start installation makes Claude
Code, Codex and OpenCode available from private tools storage; the image itself
contains no provider CLI or provider credentials.

Open **Company → People → Hire**, enter the expert details, then choose the plan
or configured local endpoint, model, harness and supported effort. Hire creates a
fresh agent session and adds the expert to the company. An existing session is not
required. A local endpoint can use OpenCode or an owner-configured compatible
harness; the endpoint and model do not define the expert's identity or memories.

## Exposure

The published port is loopback-only. To reach the console from another device, front it
with an authenticated proxy or tunnel (for example `tailscale serve`), not by publishing
the port on all interfaces. The container's user has passwordless sudo inside the
container; treat anyone who can run an agent in it as that user.
