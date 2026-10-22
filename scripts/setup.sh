#!/usr/bin/env bash
# Reverie setup: run one Reverie server from the published image with Docker or Podman.
#
#   setup.sh                    install or start the latest release
#   setup.sh --version 0.1.0    install or switch to that release (an upgrade backs up console state first)
#   setup.sh --rollback         go back to the release that ran before the last switch, with its backed-up state
#   setup.sh --password         print the internal runtime credential (advanced)
#   setup.sh --owner            manual host provisioning; prints a temporary password
#   setup.sh --offline [PATH]   load a local image archive (default ./reverie-image.tar); never pull
#   setup.sh --dry-run ...      print every command, change nothing
#
# Options: --port N (default 3000), --name NAME (default reverie; also the volumes NAME-data and NAME-home),
#          --image REF (default ghcr.io/jgoppert/reverie), --with-claude-code (installs that CLI at start,
#          under your own account and its license), --engine docker|podman.
# The server listens on 127.0.0.1 only. Expose it further only behind your own authenticated proxy or tunnel.
set -euo pipefail

image=ghcr.io/jgoppert/reverie version=latest port=3000 name=reverie engine= mode=install dry=0 clis=
offline=0 archive=./reverie-image.tar
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version=${2#v}; shift ;;
    --port) port=$2; shift ;;
    --name) name=$2; shift ;;
    --image) image=$2; shift ;;
    --engine) engine=$2; shift ;;
    --offline)
      offline=1
      if [ "$#" -gt 1 ] && [[ "$2" != --* ]]; then archive=$2; shift; fi
      ;;
    --with-claude-code) clis="claude" ;;
    --rollback) mode=rollback ;;
    --password) mode=password ;;
    --owner) mode=owner ;;
    --dry-run) dry=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$port" in ''|*[!0-9]*) echo "--port needs a number" >&2; exit 2 ;; esac
case "$name" in ''|*[!A-Za-z0-9_.-]*) echo "--name may use letters, digits, . _ -" >&2; exit 2 ;; esac
if [ "$offline" = 1 ] && [ "$mode" != install ]; then
  echo "--offline is only for installation; use --owner, --password or --rollback separately" >&2
  exit 2
fi

if [ -z "$engine" ]; then
  if command -v podman >/dev/null 2>&1; then engine=podman
  elif command -v docker >/dev/null 2>&1; then engine=docker
  else
    echo "Reverie needs Docker or Podman. Install one (https://podman.io or https://docs.docker.com/engine/install/)," >&2
    echo "then run this script again." >&2
    exit 1
  fi
fi
if [ "$dry" = 0 ] && [ "$mode" != password ] && ! "$engine" info >/dev/null 2>&1; then
  echo "$engine is installed but not usable by $(id -un)." >&2
  [ "$engine" = docker ] && echo "Start it (sudo systemctl enable --now docker) and add yourself to the docker group (sudo usermod -aG docker $(id -un), then log in again)." >&2
  exit 1
fi
volume="$name-data"
home_volume="$name-home"
state_dir=${REVERIE_ROOT:-$HOME/reverie}/runtime/setup
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

start() {  # start IMAGE_REF: replace the container, keep both volumes
  if exists; then run "$engine" stop --time 30 "$name"; run "$engine" rm "$name"; fi
  local restart=(--restart unless-stopped)
  [ "$engine" = podman ] && restart=(--restart always)
  local pull_policy=()
  [ "$offline" = 0 ] || pull_policy=(--pull=never)
  run "$engine" run "${pull_policy[@]}" --detach --name "$name" "${restart[@]}" \
    --publish "127.0.0.1:$port:3000" \
    --mount "type=volume,src=$volume,dst=/instances" \
    --mount "type=volume,src=$home_volume,dst=/home/agent" \
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
  if [ "$offline" = 1 ]; then
    [ -f "$archive" ] && [ -r "$archive" ] || { echo "Local image archive is missing or unreadable: $archive" >&2; exit 1; }
    if [ "$dry" = 1 ]; then
      run "$engine" load --input "$archive"
      run "$engine" image inspect --format '{{.Id}}' "$ref"
      digest=$ref
    else
      loaded=$("$engine" load --input "$archive" 2>&1) || { printf '%s\n' "$loaded" >&2; exit 1; }
      printf '%s\n' "$loaded"
      printf '%s\n' "$loaded" | grep -Fx -- "Loaded image: $ref" >/dev/null || {
        echo "Archive did not load the requested image tag: $ref" >&2; exit 1;
      }
      digest=$("$engine" image inspect --format '{{.Id}}' "$ref") || {
        echo "Archive did not provide the requested local image: $ref" >&2; exit 1;
      }
      [[ "$digest" =~ ^(sha256:)?[0-9a-f]{64}$ ]] || { echo "Local image has no valid image ID: $ref" >&2; exit 1; }
    fi
  else
    pull "$ref"
    digest=$("$engine" image inspect --format '{{index .RepoDigests 0}}' "$ref" 2>/dev/null || true)
  fi
  # Record the exact image (by digest when the engine reports one) so a rollback returns to these bytes.
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
  # Wait for the console; never report success for a server that did not come up.
  # Without curl, speak HTTP over bash's /dev/tcp: a bare TCP connect is not enough, because
  # the engine's port proxy accepts connections before the server inside is listening.
  http_code() {
    if command -v curl >/dev/null 2>&1; then
      curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/status" || true
    else
      ( exec 3<>"/dev/tcp/127.0.0.1/$port" || exit
        printf 'GET /api/status HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n' >&3
        IFS=' ' read -r -t 5 proto status _ <&3 || exit
        case "$proto" in HTTP/1.[01]) ;; *) exit ;; esac
        case "$status" in [0-9][0-9][0-9]) printf '%s' "$status" ;; esac ) 2>/dev/null || true
    fi
  }
  up=0
  for _ in $(seq 1 90); do
    case "$(http_code)" in 2[0-9][0-9]|401) up=1; break ;; esac
    [ "$("$engine" container inspect --format '{{.State.Running}}' "$name" 2>/dev/null)" = true ] || break
    sleep 2
  done
  if [ "$up" = 0 ]; then
    echo "Reverie did not answer on 127.0.0.1:$port. Last container log lines:" >&2
    "$engine" logs --tail 50 "$name" >&2 || true
    exit 1
  fi
fi
cat <<EOF

Reverie is running: http://127.0.0.1:$port
Open the address above to create your owner account or sign in.
Manual host provisioning (advanced): $0 --owner${name:+ --name $name}
Data volume: $volume (kept across upgrades; console backups inside it)
Home volume: $home_volume (agent tools, provider logins and conversation history)
Upgrade:     $0 --version X.Y.Z      Roll back: $0 --rollback
EOF
