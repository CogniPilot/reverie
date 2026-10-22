# Running Reverie from the published image

Each release publishes a container image to `ghcr.io/jgoppert/reverie`, tagged with its
version (`0.1.0`, `0.1`, `latest`). It holds the console, the memory runtime, the generic
expert templates and a provider-tool installer. Provider CLIs are installed in private
persistent storage on first start, not bundled in the image. It holds no instance:
no identities, memories, rooms, credentials or model weights. The first start creates an
empty instance on a volume.

## Quick start

With Docker or Podman and the GitHub CLI installed:

```bash
gh release download v0.1.0 --repo jgoppert/reverie --pattern setup.sh
bash setup.sh
```

Once the repository is public, `curl -fsSLO https://github.com/jgoppert/reverie/releases/latest/download/setup.sh`
works as well, without signing in.

`setup.sh` pulls the release, starts one container named `reverie` with a data volume
`reverie-data` mounted at `/instances` and a home volume `reverie-home` mounted at
`/home/agent`, and prints the address. The console listens on
127.0.0.1:3000 only. Create the owner account once from this host shell:

~~~bash
bash setup.sh --owner
~~~

Open /owner/login in the browser and use its single sign-in form: username owner
and the one-time password printed by that command. Choose a permanent owner
password when prompted. There is no separate browser Basic-auth dialog.
Later sign-ins use your permanent owner password, not the generated legacy
console password returned by setup.sh --password. A display name is not a login
username. Existing two-factor authentication remains in effect.

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

While the package is private, log in to the registry first:

```bash
gh auth token | podman login ghcr.io --username YOUR_GITHUB_USER --password-stdin
```

## Upgrade and rollback

For a release bundle with a local image archive, follow
[offline installation](offline-install.md). `setup.sh --offline [PATH]` loads
the archive (default `./reverie-image.tar`), checks the requested image tag and
starts its local image ID with `--pull=never`. Use the image name and version
from the bundle's `IMAGE-REF.txt`; no registry login or host Nix is required.

```bash
bash setup.sh --version 0.1.1   # the first start of a new release backs up console state on the volume
bash setup.sh --rollback        # back to the previous release, with the state it backed up
```

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
