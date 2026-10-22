#!/usr/bin/env bash
#
# run-beta.sh — launch a BETA Reverie isolated from a production instance.
#
# Reverie's data dir (~/.reverie) and tmux socket (-L reverie) are process-wide
# and shared by every instance on the machine. The code now DEFAULTS to that
# production layout on port 3000 (safe for master / existing installs), so a beta
# build no longer isolates itself automatically — this wrapper opts it in:
#
#   REVERIE_INSTANCE=beta  → data dir ~/.reverie-beta + tmux socket reverie-beta
#   REVERIE_PORT=5000      → listen on 5000 instead of 3000
#
# Result: the beta runs side-by-side with prod and can never discover/attach to
# prod's live tmux sessions or clobber prod's state.json. Override either var to
# run additional named instances, e.g. REVERIE_INSTANCE=foo REVERIE_PORT=5050.
#
# Usage:  ./scripts/run-beta.sh [extra `reverie web` flags]
# Build first (the beta runs the compiled dist):  npm run build

set -euo pipefail

export REVERIE_INSTANCE="${REVERIE_INSTANCE:-beta}"
export REVERIE_PORT="${REVERIE_PORT:-5000}"

DIST="$(cd "$(dirname "$0")/.." && pwd)/dist/index.js"
if [ ! -f "$DIST" ]; then
  echo "dist not found at $DIST — run 'npm run build' first." >&2
  exit 1
fi

echo "Starting beta Reverie: instance='$REVERIE_INSTANCE' (~/.reverie-$REVERIE_INSTANCE, -L reverie-$REVERIE_INSTANCE) on port $REVERIE_PORT"
exec node "$DIST" web "$@"
