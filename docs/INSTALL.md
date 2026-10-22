# Install Reverie offline on Debian 12 (x86_64)

Transfer and extract reverie-X.Y.Z.tar.gz on the target machine, then open
a terminal in the extracted directory. The image is included; Nix and a GHCR
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
./setup.sh --offline reverie-image.tar
```

Open http://127.0.0.1:3000 on this machine and create your owner account.
For a remote machine, forward port 3000 with SSH and open the same local address.
The service binds only to loopback. Save the owner password securely.

IMAGE-REF.txt records the commit, version and Docker image ID. The archive loads
both ghcr.io/jgoppert/reverie:latest and ghcr.io/jgoppert/reverie:X.Y.Z.
Docker volumes reverie-data and reverie-home retain state across restarts.
Do not remove these volumes to upgrade. Optional provider CLIs require a network
connection and your own provider login; they are not installed by this command.

## Alternative: run the image from GHCR

The same image is published as ghcr.io/jgoppert/reverie:X.Y.Z (and :latest).
Nix is not required; you need Docker (installed and the docker group set up as
above), network access, and a GitHub account that has read access to the package.
Create a GitHub personal access token with the read:packages scope. Run the
commands below in Bash (the default Debian login shell), from the extracted
bundle directory. First log in once; the token is read without echoing it to
the terminal or saving it in shell history:

```shell
read -rsp 'GitHub token (read:packages): ' GHCR_TOKEN; echo
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io --username YOUR_GITHUB_USER --password-stdin
unset GHCR_TOKEN
```

Take the version from this bundle (or set it yourself, for example VERSION=0.2.0),
then install with setup.sh, which pulls the image, records its digest for
rollback and waits until the server answers:

```shell
VERSION=$(sed -n 's/^Version: //p' IMAGE-REF.txt)
./setup.sh --version "$VERSION"
```

Or run it directly with Docker, with the same port, volumes and restart policy:

```shell
VERSION=$(sed -n 's/^Version: //p' IMAGE-REF.txt)   # or VERSION=0.2.0
docker pull "ghcr.io/jgoppert/reverie:$VERSION"
docker run --detach --name reverie --restart unless-stopped \
  --publish 127.0.0.1:3000:3000 \
  --mount type=volume,src=reverie-data,dst=/instances \
  --mount type=volume,src=reverie-home,dst=/home/agent \
  "ghcr.io/jgoppert/reverie:$VERSION"
```

Then open http://127.0.0.1:3000 as above. To upgrade later, run
`./setup.sh --version` with the new version number; it backs up console state and keeps both volumes.
