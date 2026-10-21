#!/usr/bin/env bash
# Reverie setup: run one Reverie server from the published image with Docker or Podman.
#
#   setup.sh                    install or start the latest release
#   setup.sh --version 0.1.0    install or switch to that release (an upgrade backs up console state first)
#   setup.sh --rollback         go back to the release that ran before the last switch, with its backed-up state
#   setup.sh --password         print the owner login
#   setup.sh --owner            create the owner account; prints a one-time password for /owner/login
#   setup.sh --dry-run ...      print every command, change nothing
#
# Options: --port N (default 3000), --name NAME (default reverie; also the data volume NAME-data),
#          --image REF (default ghcr.io/jgoppert/reverie), --with-claude-code (installs that CLI at start,
#          under your own account and its license), --engine docker|podman.
# The server listens on 127.0.0.1 only. Expose it further only behind your own authenticated proxy or tunnel.
set -euo pipefail

image=ghcr.io/jgoppert/reverie version=latest port=3000 name=reverie engine= mode=install dry=0 clis=
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version=${2#v}; shift ;;
    --port) port=$2; shift ;;
    --name) name=$2; shift ;;
    --image) image=$2; shift ;;
    --engine) engine=$2; shift ;;
    --with-claude-code) clis="claude-code" ;;
    --rollback) mode=rollback ;;
    --password) mode=password ;;
    --owner) mode=owner ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$port" in ''|*[!0-9]*) echo "--port needs a number" >&2; exit 2 ;; esac
case "$name" in ''|*[!A-Za-z0-9_.-]*) echo "--name may use letters, digits, . _ -" >&2; exit 2 ;; esac

if [ -z "$engine" ]; then
  if command -v podman >/dev/null 2>&1; then engine=podman
  elif command -v docker >/dev/null 2>&1; then engine=docker
  else
    echo "Reverie needs Docker or Podman. Install one (https://podman.io or https://docs.docker.com/engine/install/)," >&2
    echo "then run this script again." >&2
    exit 1
  fi
fi
volume="$name-data"
state_dir=${XDG_CONFIG_HOME:-$HOME/.config}/reverie
state="$state_dir/$name.versions"   # one image reference per line, newest last

run() { if [ "$dry" = 1 ]; then printf '+ %s\n' "$*"; else "$@"; fi; }
exists() { "$engine" container inspect "$name" >/dev/null 2>&1; }

if [ "$mode" = password ]; then
  exec "$engine" exec "$name" cat /instances/default/owner-password
fi
if [ "$mode" = owner ]; then
  # From this host shell, never from inside a Reverie session: the one-time password is printed here only.
  run "$engine" exec -e REVERIE_DATA_DIR=/instances/default/console "$name" reverie owner bootstrap --username owner --enforce
  exit
fi

pull() {
  if ! run "$engine" pull "$1"; then
    echo "Could not pull $1. If the package is private, log in first, for example:" >&2
    echo "  gh auth token | $engine login ghcr.io --username YOUR_GITHUB_USER --password-stdin" >&2
    exit 1
  fi
}

start() {  # start IMAGE_REF: replace the container, keep the volume
  if exists; then run "$engine" stop --time 30 "$name"; run "$engine" rm "$name"; fi
  local restart=(--restart unless-stopped)
  [ "$engine" = podman ] && restart=(--restart always)
  run "$engine" run --detach --name "$name" "${restart[@]}" \
    --publish "127.0.0.1:$port:3000" \
    --mount "type=volume,src=$volume,dst=/instances" \
    --env "REVERIE_INSTALL_CLIS=$clis" \
    "$1"
}

if [ "$mode" = rollback ]; then
  [ -s "$state" ] && [ "$(wc -l < "$state")" -ge 2 ] || { echo "nothing to roll back to (no earlier release recorded in $state)" >&2; exit 1; }
  previous=$(tail -n 2 "$state" | head -n 1)
  echo "Rolling back $name to $previous and restoring the console state backed up when it was last upgraded."
  # The newest backup is the state the previous release left behind; restore it with the previous image's tools.
  run "$engine" stop --time 30 "$name" || true
  run "$engine" run --rm --mount "type=volume,src=$volume,dst=/instances" --entrypoint /usr/bin/env "$previous" \
    bash -c 'set -e; d=/instances/default; b=$(ls -t "$d"/backups/console-*.tar | head -n 1); mv "$d/console" "$d/console.rolled-back-$(date -u +%Y%m%dT%H%M%SZ)"; tar -C "$d" -xf "$b"; echo "restored $b"'
  start "$previous"
  [ "$dry" = 1 ] || { head -n -1 "$state" > "$state.tmp" && mv "$state.tmp" "$state"; }
else
  ref="$image:$version"
  pull "$ref"
  # Record the exact image (by digest when the engine reports one) so a rollback returns to these bytes.
  digest=$("$engine" image inspect --format '{{index .RepoDigests 0}}' "$ref" 2>/dev/null || true)
  start "${digest:-$ref}"
  if [ "$dry" = 0 ]; then
    mkdir -p "$state_dir"
    [ "$(tail -n 1 "$state" 2>/dev/null)" = "${digest:-$ref}" ] || printf '%s\n' "${digest:-$ref}" >> "$state"
  fi
fi

if [ "$engine" = podman ] && command -v systemctl >/dev/null 2>&1; then
  # Podman restarts "always" containers at boot through this user unit; lingering keeps it running after logout.
  run systemctl --user enable --now podman-restart.service 2>/dev/null ||
    echo "note: enable podman-restart.service (systemctl --user) so Reverie starts at boot" >&2
fi

if [ "$dry" = 0 ]; then
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$port/api/status" 2>/dev/null || [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/status")" = 401 ]; then
      break
    fi
    sleep 2
  done
fi
cat <<EOF

Reverie is running: http://127.0.0.1:$port
Owner login: user "owner", password from:  $0 --password${name:+ --name $name}
Owner sign-in: on first install run  $0 --owner${name:+ --name $name}  and sign in at /owner/login
Data volume: $volume (kept across upgrades; console backups inside it)
Upgrade:     $0 --version X.Y.Z      Roll back: $0 --rollback
EOF
