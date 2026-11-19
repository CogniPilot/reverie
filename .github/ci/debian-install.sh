#!/usr/bin/env bash
# Runs only in a disposable privileged Debian container; no host Docker socket.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y sudo
useradd --create-home --shell /bin/bash installer
printf 'installer ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/installer
mkdir /home/installer/bundle
tar -xzf /input/reverie-*.tar.gz -C /home/installer/bundle
chown -R installer:installer /home/installer/bundle
# Execute the two command blocks from the shipped document, without copying
# their commands into a second implementation.
awk '
  /^```$/ && in_block {
    close(step)
    in_block = 0
    next
  }
  /^```bash$/ && !in_block {
    step = "/home/installer/step-" count++ ".sh"
    print "set -euo pipefail\ncd /home/installer/bundle" > step
    in_block = 1
    next
  }
  in_block { print > step }
  END {
    if (in_block || count != 2) {
      print "INSTALL.md must contain two complete Bash blocks" > "/dev/stderr"
      exit 1
    }
  }
' /home/installer/bundle/INSTALL.md
su - installer -c 'bash /home/installer/step-0.sh'
# Containers have no systemd. This is the only infrastructure substitution;
# the packaged Debian daemon and client run entirely inside this container.
dockerd > /tmp/dockerd.log 2>&1 &
daemon_pid=$!
trap 'docker rm -f reverie >/dev/null 2>&1 || true; kill "$daemon_pid" 2>/dev/null || true' EXIT
ready=0
for _ in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { cat /tmp/dockerd.log; exit 1; }
# The runner bind-mount supplies ordinary filesystem storage for overlay2.
# Refuse a fallback to vfs, whose full-layer copies exhausted the CI disk.
driver=$(docker info --format '{{.Driver}}')
echo "Debian Docker storage driver: $driver"
[ "$driver" = overlay2 ] || { cat /tmp/dockerd.log; exit 1; }
df -h / /var/lib/docker
# Fresh login picks up the group; no curl installed, exercising setup's TCP fallback.
su - installer -c 'bash /home/installer/step-1.sh'
test "$(docker exec reverie curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/status)" = 401
# Exercise browser owner bootstrap and authenticated access against this installation.
docker exec -i reverie node --input-type=module < /ci/boot-owner.mjs
