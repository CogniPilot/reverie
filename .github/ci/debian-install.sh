#!/usr/bin/env bash
# Runs only in a disposable privileged Debian container; no host Docker socket.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y sudo python3
useradd --create-home --shell /bin/bash installer
printf 'installer ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/installer
mkdir /home/installer/bundle
tar -xzf /input/reverie-*.tar.gz -C /home/installer/bundle
chown -R installer:installer /home/installer/bundle
# Execute the two command blocks from the shipped document, without copying
# their commands into a second implementation.
python3 - <<'PY'
from pathlib import Path
text = Path('/home/installer/bundle/INSTALL.md').read_text()
blocks = [part.split('```', 1)[0] for part in text.split('```bash\n')[1:]]
assert len(blocks) == 2
for index, block in enumerate(blocks):
    Path(f'/home/installer/step-{index}.sh').write_text('set -euo pipefail\ncd /home/installer/bundle\n' + block)
PY
su - installer -c 'bash /home/installer/step-0.sh'
# Containers have no systemd. This is the only infrastructure substitution;
# the packaged Debian daemon and client run entirely inside this container.
dockerd --storage-driver=vfs > /tmp/dockerd.log 2>&1 &
daemon_pid=$!
trap 'docker rm -f reverie >/dev/null 2>&1 || true; kill "$daemon_pid" 2>/dev/null || true' EXIT
ready=0
for _ in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { cat /tmp/dockerd.log; exit 1; }
# Fresh login picks up the group; no curl installed, exercising setup's TCP fallback.
su - installer -c 'bash /home/installer/step-1.sh'
test "$(docker exec reverie curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/status)" = 401
# Exercise browser owner bootstrap and authenticated access against this installation.
docker exec reverie bash -c 'umask 077; printf "machine 127.0.0.1 login owner password %s\n" "$(cat /instances/default/owner-password)" > "$TMPDIR/netrc"'
docker exec -i reverie bash -s < /ci/boot-owner.sh
