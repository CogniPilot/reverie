# Installing a release bundle

The bundle contains the Docker image archive, README, documentation and setup
script from one release, with `SHA256SUMS` and `IMAGE-REF.txt`. The latter records
the exact saved image tag, including its registry/name and release version.
Use a host matching the image CPU architecture stated in the bundled README.

On Debian the host needs Docker Engine installed and running, Bash, tar,
coreutils, grep and a browser. Nix, Skopeo, Node and Python are not host
requirements. No GitHub or registry sign-in is needed for local installation.
Provider sign-ins and hosted models still need internet access. Claude Code is
not included in the image; its optional installation also needs internet and
must be requested explicitly with `--with-claude-code`.

From the extracted bundle directory:

```bash
sha256sum -c SHA256SUMS
IMAGE_REF=$(cat IMAGE-REF.txt)
bash setup.sh --engine docker --offline ./reverie-image.tar \
  --image "${IMAGE_REF%:*}" --version "${IMAGE_REF##*:}"
```

`--offline` without a path uses `./reverie-image.tar`; an explicit path may also
name a compressed Docker archive. Keep `IMAGE-REF.txt` alongside the bundle and
use its fully qualified saved tag, with a numeric version such as `0.1.1`.
The script checks that the load supplied that tag, resolves its local image ID
and starts with `--pull=never`. A missing or rejected archive, a wrong tag or
failed image inspection stops before any existing container is stopped or removed.
Loading can still add images to the local image store before a later check fails.

The default container is `reverie`, with data in the `reverie-data` volume.
An installation using that name replaces the existing container but preserves
its volume. For a separate first-install rehearsal, choose a fresh name and port
with `--name example --port 3100`; the new volume is then `example-data`. Do not
delete an existing volume to start over. Only port 3000 inside the container is
published, on the host's loopback address. Tailscale is not required.

Print the console password and bootstrap the owner from this host terminal,
before hiring any experts:

```bash
bash setup.sh --engine docker --password
bash setup.sh --engine docker --owner
```

Use the same `--name` for these commands if you selected a different container
name. Keep both printed passwords private. Open `http://127.0.0.1:3000` (or the
selected port), enter the console credentials with username `owner`, then visit
`/owner/login`. Sign in with the one-time owner password and replace it when
prompted. The one-time password expires after 30 minutes. The console password
alone does not authorize owner pages or plan-account management.

Continue with the README's First login steps. Accounts and settings stay on the
volume across recreation. Install a later bundle with the same name and volume
using that bundle's image tag and archive. Registry installs and rollback options
are documented in [the image guide](image.md); offline installation does not
download any missing older rollback image.
