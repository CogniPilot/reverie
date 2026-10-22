#!/bin/bash
# Image startup: prepare one instance on the data volume, then run the given command (default: the console).
# Every step is idempotent, so a restart or an upgrade on the same volume runs the same path.
#   REVERIE_VERSION       image build id, set at build time; a change means an upgrade
#   REVERIE_DATA          instance directory on the mounted volume (default /instances/default)
#   REVERIE_INSTALL_CLIS  opt-in agent CLIs to install at start, space-separated: claude-code
#   REVERIE_PASSWORD      owner password; when unset, one is generated on first start and kept on the volume
set -euo pipefail
umask 077
log() { printf 'reverie-start: %s\n' "$*" >&2; }

DATA=${REVERIE_DATA:-/instances/default}
mkdir -p "$DATA/console" "$DATA/backups" "$DATA/tools" "${TMPDIR:-/tmp}"
REVERIE_DATA_DIR=${REVERIE_DATA_DIR:-$DATA/console}; export REVERIE_DATA_DIR

# Upgrade: the first start of a new image build backs up the console state before the console reads it
# (the console migrates its own files on start).
version=${REVERIE_VERSION:-dev}
previous=$(cat "$DATA/.image-version" 2>/dev/null || true)
if [ -n "$previous" ] && [ "$previous" != "$version" ]; then
  backup="$DATA/backups/console-${previous//[^A-Za-z0-9._-]/_}-$(date -u +%Y%m%dT%H%M%SZ).tar"
  tar -C "$DATA" -cf "$backup" console
  log "upgrade $previous -> $version: console state backed up to $backup"
fi
printf '%s\n' "$version" > "$DATA/.image-version"

# Owner authorization: a volume without an owner account or a policy marker starts in enforce, so every
# owner route (plans, settings, the CLI registry, the mode switch) needs the signed-in owner, never only
# the shared REVERIE_PASSWORD that every process in the container inherits. Agents keep their own routes.
# A volume that has an account or a marker keeps its policy. The owner creates the account from a host
# shell (setup.sh --owner) and signs in at /owner/login.
owner_marker="$REVERIE_DATA_DIR/owner-auth.policy"
if [ ! -e "$REVERIE_DATA_DIR/owner-auth.json" ] && [ ! -e "$owner_marker" ] && [ ! -L "$owner_marker" ]; then
  mkdir -p "$REVERIE_DATA_DIR"
  printf 'enforce\n' > "$owner_marker.tmp" && mv "$owner_marker.tmp" "$owner_marker"
  log "owner authorization: enforce; create the owner account from the host with: setup.sh --owner"
fi

# Owner login: the console listens on every container interface (port publishing needs that), so it never
# starts without a password. The password stays on the volume and is never printed.
if [ -z "${REVERIE_PASSWORD:-}" ]; then
  secret="$DATA/owner-password"
  if [ ! -s "$secret" ]; then
    python3 -I -c 'import secrets; print(secrets.token_urlsafe(18))' > "$secret.tmp" && mv "$secret.tmp" "$secret"
    log "first start: owner password created; read it with: docker exec <container> cat $secret"
  fi
  REVERIE_PASSWORD=$(cat "$secret")
  export REVERIE_PASSWORD
fi
export REVERIE_USERNAME=${REVERIE_USERNAME:-owner}
printf 'REVERIE_USERNAME=%s\nREVERIE_PASSWORD=%s\n' "$REVERIE_USERNAME" "$REVERIE_PASSWORD" > "$REVERIE_DATA_DIR/.env.tmp"
mv "$REVERIE_DATA_DIR/.env.tmp" "$REVERIE_DATA_DIR/.env"

# The default Claude and Codex profiles keep their sign-in under these directories; on the volume they survive a recreate.
mkdir -p "$DATA/accounts/claude" "$DATA/accounts/codex"
export CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$DATA/accounts/claude} CODEX_HOME=${CODEX_HOME:-$DATA/accounts/codex}

# Opt-in agent CLIs that the image does not ship. They install on the volume, so a recreated container keeps them.
# No network or a failed install is a warning, never a failed start.
export PATH="$DATA/tools/bin:$PATH"
for cli in ${REVERIE_INSTALL_CLIS:-}; do
  case "$cli" in
    claude-code) package=@anthropic-ai/claude-code; command=claude ;;
    *) log "unknown CLI '$cli' in REVERIE_INSTALL_CLIS, skipped"; continue ;;
  esac
  if command -v "$command" >/dev/null 2>&1; then continue; fi
  if timeout 300 npm install --global --prefix "$DATA/tools" --no-fund --no-audit "$package" >"$DATA/tools/install-$cli.log" 2>&1; then
    log "installed $cli"
  else
    log "could not install $cli (offline?); continuing without it, see $DATA/tools/install-$cli.log"
  fi
done

[ "$#" -gt 0 ] || set -- reverie web --host 0.0.0.0 --port "${REVERIE_PORT:-3000}"
exec "$@"
