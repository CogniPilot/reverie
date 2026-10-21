# Running Reverie from the published image

Each release publishes a container image to `ghcr.io/jgoppert/reverie`, tagged with its
version (`0.1.0`, `0.1`, `latest`). It holds the console, the memory runtime, the generic
expert templates and the open-source agent CLIs (OpenCode, Codex). It holds no instance:
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
`reverie-data` mounted at `/instances`, and prints the address. The console listens on
`127.0.0.1:3000` only. Sign in as `owner` with the password the first start generated:

```bash
bash setup.sh --password
```

A new server also requires the owner sign-in for owner pages and settings (plan accounts,
CLIs, settings): every process in the container shares that first password, so it alone is
not enough. Create the owner account once from this host shell, then sign in at `/owner/login`
with the one-time password it prints (valid 30 minutes; the first sign-in sets your own):

```bash
bash setup.sh --owner
```

Options: `--version X.Y.Z`, `--port N`, `--name NAME` (a second server on the same machine),
`--with-claude-code` (installs that CLI at start, on the volume, under your own account and
its license; the image does not ship it), `--dry-run`.

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

The container is replaced; the volume is kept. `setup.sh` records each release it started
in `~/.config/reverie/<name>.versions` by image digest, so a rollback returns to the exact
bytes that ran before.

## What the image does at start

`/usr/local/bin/reverie-start` runs before the console on every start:

1. creates the instance directory on the volume (`REVERIE_DATA`, default `/instances/default`)
   and the temporary directory;
2. on the first start after an image change (`REVERIE_VERSION` differs from the volume's
   record), writes a tar backup of `console/` under `backups/` before the console migrates
   its files;
3. sets the owner login: `CODEMAN_PASSWORD` from the environment, or a generated password
   kept at `owner-password` (mode 0600) on the volume. The console never starts without one;
4. installs the opt-in CLIs named in `REVERIE_INSTALL_CLIS` onto the volume, skipping
   cleanly when offline, and points the default Claude and Codex profiles at
   `accounts/claude` and `accounts/codex` on the volume so a recreate keeps a sign-in;
5. runs the given command, by default `reverie web --host 0.0.0.0 --port 3000`.

Any other command runs after the same preparation. The development and personal
launchers (`scripts/fleet-container`, `scripts/reverie-recreate`) bypass it with
`--entrypoint /usr/bin/env`, because they mount their own instance and workspace.

## Hiring the first employee (interim, until hire-by-model lands)

The Company page's Hire form adopts an existing agent session; with no session yet it stays
disabled. Until hiring by model, plan and effort ships, start the first session from the
legacy screen: open `http://127.0.0.1:3000/?legacy=1`, choose the plan account and model in
its Run controls and start a session, then return to Company and hire it. Sign-ins for plan
accounts live on the Plans page. This route is temporary and is listed as a known rough
edge of this release.

## Exposure

The published port is loopback-only. To reach the console from another device, front it
with an authenticated proxy or tunnel (for example `tailscale serve`), not by publishing
the port on all interfaces. The container's user has passwordless sudo inside the
container; treat anyone who can run an agent in it as that user.
