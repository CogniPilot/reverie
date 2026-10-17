#!/bin/sh
# Corrects ownership - host bind mounts, and the image-baked CLI prefix -
# then drops to PUID:PGID.
#
# Compose binds CODEMAN_APPDATA_PATH and CODEMAN_CASES_PATH from the host. When
# either path does not exist yet - a first run, a cleared application-data
# directory, a restored backup - the Docker daemon creates it owned by root,
# and an unprivileged server cannot then create its own state directory. The
# result is a container that restarts forever on:
#
#   Failed to start web server: EACCES: permission denied, mkdir '/home/<user>/.codeman'
#
# Running this as root and dropping afterwards removes that failure mode without
# leaving the server privileged. The same root start also lets it re-assert
# /opt/codeman-cli's ownership on every start, not just at image build time -
# see the comment at that chown below for why that matters for anyone who
# runs the compose file directly rather than through Start-Codeman.sh.
#
# Capabilities this script needs against the compose file's `cap_drop: ALL`
# (test/docker-entrypoint.test.ts pins the list against docker-compose.yaml):
#   CHOWN + DAC_OVERRIDE  the chown of a root-owned bind source below
#   SETUID + SETGID       the setpriv drop itself
#   KILL                  NOT used here, but required by the container: with
#                         `init: true` tini is PID 1 and runs as root while the
#                         server runs as PUID, and signalling a process of a
#                         different uid needs CAP_KILL. Without it every
#                         `docker compose down`/`restart` ends in tini dying with
#                         "Unexpected error when forwarding signal" and the
#                         server being SIGKILLed instead of stopping cleanly.

set -eu

# Honour an explicit `user:` in Compose: when the container was not started as
# root there is nothing to correct and no privilege to drop.
if [ "$(id -u)" -ne 0 ]; then
  exec "$@"
fi

# Everything below runs as root and calls stat, chown, id, setpriv and friends
# by bare name, so the lookup path must not contain a directory the runtime
# account can write to. /opt/codeman-cli/bin is exactly that (it is chowned to
# PUID:PGID so sessions can update the agent CLIs in place), and the image
# appends it to PATH for the server's sake. Resolve root's commands through the
# system directories only, and hand the image's full PATH back to the server at
# the exec below, since Reverie resolves the agent CLIs through it.
runtime_path=$PATH
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

: "${PUID:=1000}"
: "${PGID:=1000}"

# The capabilities the compose file must grant, named in the diagnosis below so
# an out-of-tree compose file (Unraid's Compose Manager, a hand-written unit)
# fails with a one-line fix instead of a restart loop.
required_caps='CHOWN, DAC_OVERRIDE, KILL, SETGID, SETUID'

# Pre-flight the drop itself before touching anything. A container started with
# `cap_drop: ALL` and none of the additions above fails here, and would otherwise
# die at the final exec with a bare "setpriv: setresuid failed: Operation not
# permitted" after chown had already failed, or worse, misreport a perfectly
# writable directory as unwritable because the probe below could not drop
# privileges to test it.
if ! setpriv --reuid "$PUID" --regid "$PGID" --clear-groups true 2>/dev/null; then
  printf 'entrypoint: cannot drop privileges to PUID:PGID (%s:%s).\n' "$PUID" "$PGID" >&2
  printf 'entrypoint: this image starts as root and drops with setpriv, which needs\n' >&2
  printf 'entrypoint:   cap_add: [%s]\n' "$required_caps" >&2
  printf 'entrypoint: on top of cap_drop: ALL (see docker/docker-compose.yaml). Add them to the\n' >&2
  printf 'entrypoint: compose file that started this container, or set `user:` to skip the drop entirely.\n' >&2
  exit 1
fi

# Preserve the supplementary groups Compose granted through group_add - that is
# how the Docker socket stays reachable - while discarding root's own group.
supplementary=$(id -G | tr ' ' '\n' | grep -vx 0 | paste -sd, -)
[ -n "$supplementary" ] || supplementary="$PGID"

# Writable as the account the server is about to become? A real probe, run as
# exactly the identity the final exec below produces (PUID, PGID, the same
# supplementary groups, capabilities dropped), rather than a comparison of
# owners: ownership is not writability. A group-writable tree owned by another
# account, an ACL, or a CIFS/NFS mount that reports some unrelated uid are all
# fine to run on and would all fail an owner check.
writable_as_runtime() {
  setpriv --reuid "$PUID" --regid "$PGID" --groups "$supplementary" test -w "$1" 2>/dev/null
}

for target in "${HOME:-}" "${CODEMAN_CASES_PATH:-}"; do
  [ -n "$target" ] && [ -d "$target" ] || continue
  owner=$(stat -c '%u:%g' "$target")
  [ "$owner" = "${PUID}:${PGID}" ] && continue

  # Only ever correct a directory the DAEMON created: root-owned, because
  # neither PUID nor PGID existed yet when it materialised the missing bind
  # source. Anything else - a host tree that legitimately belongs to some
  # OTHER account, such as an existing CODEMAN_CASES_PATH the README already
  # allows pointing at a normal project directory - is not this container's
  # to reassign; recursively chowning it on every mismatch silently rewrote
  # a credentials tree or a projects directory to PUID:PGID with one log
  # line to explain it. Such a directory is left alone and only PROBED below.
  #
  # The chown is deliberately not fatal. A bind mount backed by NFS, CIFS or a
  # rootless daemon can refuse chown while still being perfectly writable, and
  # the probe below is what decides whether the server can run on it.
  if [ "${owner%%:*}" = '0' ]; then
    if chown -R "${PUID}:${PGID}" "$target" 2>/dev/null; then
      printf 'entrypoint: corrected ownership of %s to %s:%s\n' "$target" "$PUID" "$PGID"
    else
      printf 'entrypoint: warning: cannot change ownership of %s to %s:%s; checking whether it is writable anyway\n' \
        "$target" "$PUID" "$PGID" >&2
    fi
  fi

  if writable_as_runtime "$target"; then
    if [ "${owner%%:*}" != '0' ]; then
      printf 'entrypoint: %s is owned by %s, not %s:%s, but is writable as the runtime account; leaving its ownership alone\n' \
        "$target" "$owner" "$PUID" "$PGID"
    fi
    continue
  fi

  printf 'entrypoint: %s is not writable as PUID:PGID (%s:%s); it is owned by %s.\n' \
    "$target" "$PUID" "$PGID" "$owner" >&2
  printf 'entrypoint: refusing to change ownership of a directory this container did not create.\n' >&2
  printf 'entrypoint: either chown it on the host, make it writable to %s:%s, or set PUID/PGID to match its owner.\n' \
    "$PUID" "$PGID" >&2
  exit 1
done

# /opt/codeman-cli (the four agent CLIs) is chowned to PUID:PGID once, at
# image BUILD time, from the PUID/PGID build args - server.Dockerfile's own
# comment on that RUN step explains why it lives in its own prefix rather than
# /usr/local. Unlike HOME/CODEMAN_CASES_PATH above, that bake happens only
# when the image is actually rebuilt (`docker compose up --build`, which
# Start-Codeman.sh always does) - a deployment that instead runs the compose
# file directly (Unraid's Compose Manager, a native Debian systemd unit, any
# `docker compose up`/`restart` with no --build) can change PUID/PGID in .env
# and restart without ever rebuilding, at which point the container runs as
# the NEW uid while the CLI directory is still owned by the OLD one baked into
# the image layer - silently breaking the very "self-update a CLI in place"
# fix this directory exists for. Re-assert it here, every start, unconditionally:
# unlike the host bind mounts above, this is pure image content Reverie itself
# populated, never host data that might legitimately belong to someone else,
# so there is no ownership to be careful about - it is always correct for it
# to be owned by whoever this container is about to run as.
if [ -d /opt/codeman-cli ] && [ "$(stat -c '%u:%g' /opt/codeman-cli)" != "${PUID}:${PGID}" ]; then
  chown -R "${PUID}:${PGID}" /opt/codeman-cli
fi

# Discarding group 0 is right for root's own group, but it also discards a
# `group_add: 0` that was there to reach a Docker socket owned by root:root.
# The previous image ran as PUID with that group kept, so say so rather than
# letting Docker-case support vanish silently on such a host.
if [ -S /var/run/docker.sock ] && [ "$(stat -c '%g' /var/run/docker.sock)" = '0' ]; then
  printf 'entrypoint: warning: /var/run/docker.sock is owned by group 0, which is dropped along with root;\n' >&2
  printf 'entrypoint: warning: Docker cases will not work from this container. Give the socket a dedicated\n' >&2
  printf 'entrypoint: warning: group on the host and set DOCKER_SOCKET_GID to it.\n' >&2
fi

# No `--bounding-set -all` here: it is a silent no-op without CAP_SETPCAP, which
# the compose file deliberately does not grant, and `no-new-privileges` already
# makes the bounding set moot. The reuid/regid drop leaves CapPrm/CapEff empty.
# The image's full PATH goes back to the server here; see the top of the file.
exec setpriv --reuid "$PUID" --regid "$PGID" --groups "$supplementary" \
  env PATH="$runtime_path" "$@"
