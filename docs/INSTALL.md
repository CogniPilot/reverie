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
