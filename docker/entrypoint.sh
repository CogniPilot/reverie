#!/bin/bash
# Image startup: prepare one instance on the data volume, then run the given command (default: the console).
# Every step is idempotent, so a restart or an upgrade on the same volume runs the same path.
#   REVERIE_VERSION       image build id, set at build time; a change means an upgrade
#   REVERIE_DATA          instance directory on the mounted volume (default /instances/default)
#   REVERIE_INSTALL_CLIS  defaults to claude codex opencode; set none to skip installation
#   REVERIE_PASSWORD      internal runtime credential; generated privately when unset
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

# The backend permits browser account creation only when both owner account and
# durable policy marker are absent. It enforces owner authorization before claim.
# Never manufacture a marker here: that would make a fresh instance look claimed.
# Existing accounts, markers, symlinks and unreadable state stay backend-managed
# and fail closed; host bootstrap/reset tools remain available for recovery.
export REVERIE_OWNER_SETUP=1

# Internal runtime authentication: the console listens on every container interface (port publishing needs that), so it never
# starts without a password. The password stays on the volume and is never printed.
if [ -z "${REVERIE_PASSWORD:-}" ]; then
  secret="$DATA/owner-password"
  if [ ! -s "$secret" ]; then
    python3 -I -c 'import secrets; print(secrets.token_urlsafe(18))' > "$secret.tmp" && mv "$secret.tmp" "$secret"
    log "first start: internal runtime credential created; create your owner account in the browser"
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

# Provider programs are installed into the user's persistent volume on first start.
# The web server starts immediately; offline installation failures remain retryable.
export PATH="$DATA/tools/bin:$PATH"
export REVERIE_DATA="$DATA"
if command -v reverie-install-clis >/dev/null 2>&1; then
  reverie-install-clis </dev/null &
else
  log 'provider installer unavailable; account sign-in requires provider tools'
fi

[ "$#" -gt 0 ] || set -- reverie web --host 0.0.0.0 --port "${REVERIE_PORT:-3000}"
exec "$@"
