# Install Reverie offline on Debian 12 (x86_64)

Transfer and extract reverie-X.Y.Z.tar.gz on the target machine, then open
a terminal in the extracted directory. A release whose bundle is 2 GiB or more
attaches it as reverie-X.Y.Z.tar.gz.part-00, part-01, … plus
reverie-X.Y.Z.tar.gz.sha256: download them all into one directory and join them
first with `cat reverie-X.Y.Z.tar.gz.part-* > reverie-X.Y.Z.tar.gz` and
`sha256sum -c reverie-X.Y.Z.tar.gz.sha256`. The image is included; Nix and a GHCR
login are not required. Installing Docker requires access to Debian repositories.
Run these commands as your normal user with sudo permission:

```bash
sudo apt-get update
sudo apt-get install -y docker.io
sudo usermod -aG docker "$USER"
```

Log out and log in again so the docker group takes effect. On a normal Debian
system Docker starts automatically; if needed run
`sudo systemctl enable --now docker`. In the extracted directory, run:

```bash
sha256sum -c SHA256SUMS
IMAGE=$(sed -n 's/^Repository: //p' IMAGE-REF.txt)
VERSION=$(sed -n 's/^Version: //p' IMAGE-REF.txt)
./setup.sh --engine docker --offline reverie-image.tar --image "$IMAGE" --version "$VERSION"
```

Open http://127.0.0.1:3000 on this machine and create your owner account.
For a remote machine, forward port 3000 with SSH and open the same local address.
The service binds only to loopback. Save the owner password securely.

IMAGE-REF.txt records the commit, version and Docker image ID. The archive loads
both ghcr.io/cognipilot/reverie:latest and ghcr.io/cognipilot/reverie:X.Y.Z.
The Repository field is authoritative for a bundle built by a different repository
owner; CI normalizes that owner to lowercase through the standalone setup policy.
Docker volumes reverie-data and reverie-home retain state across restarts.
Do not remove these volumes to upgrade. On first start with network access the
container installs its supported provider CLIs in the background (without
network it skips them; a provider is prepared again when first used). Each
needs your own provider login and license.

## Alternative: run the image from GHCR

The same image is published as ghcr.io/cognipilot/reverie:X.Y.Z (and :latest).
Nix is not required; you need Docker (installed and the docker group set up as
above), network access, and a GitHub account that has read access to the package.
Create a GitHub personal access token (classic) with the read:packages scope;
GHCR does not accept fine-grained tokens for this. Run the
commands below in Bash (the default Debian login shell), from the extracted
bundle directory. First log in once; the token is read without echoing it to
the terminal or saving it in shell history:

```shell
read -rsp 'GitHub token (read:packages): ' GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username YOUR_GITHUB_USER --password-stdin
unset GHCR_TOKEN
```

Take the version from this bundle (or set it yourself, for example VERSION=0.3.0),
then install with setup.sh, which pulls the image, records its digest for
rollback and waits until the server answers:

```shell
VERSION=$(sed -n 's/^Version: //p' IMAGE-REF.txt)
./setup.sh --engine docker --version "$VERSION"
```

Or run it directly with Docker, with the same port, volumes and restart policy:

```shell
VERSION=$(sed -n 's/^Version: //p' IMAGE-REF.txt)   # or VERSION=0.3.0
docker pull "ghcr.io/cognipilot/reverie:$VERSION"
docker run --detach --name reverie --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --mount type=volume,src=reverie-data,dst=/instances \
  --mount type=volume,src=reverie-home,dst=/home/agent \
  "ghcr.io/cognipilot/reverie:$VERSION"
```

Then open http://127.0.0.1:3000 as above. To upgrade later, run
`./setup.sh --engine docker --version` with the new version number; it backs up console state and keeps both volumes.

Older released bundles keep their original metadata, tags and setup script. In
particular, historical `ghcr.io/jgoppert/reverie` archives are not renamed by this
release. Use the setup script shipped with that archive, or select its recorded
namespace explicitly with `--image ghcr.io/jgoppert/reverie --version X.Y.Z`.

Release-asset attachment and GHCR image publication are independent CI outcomes.
Attached assets alone do not establish that a registry push succeeded.
