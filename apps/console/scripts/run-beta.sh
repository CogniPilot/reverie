#!/usr/bin/env bash
#
# run-beta.sh — launch a BETA Reverie isolated from a production instance.
#
# Reverie's data dir (~/.codeman) and tmux socket (-L codeman) are process-wide
# and shared by every instance on the machine. The code now DEFAULTS to that
# production layout on port 3000 (safe for master / existing installs), so a beta
# build no longer isolates itself automatically — this wrapper opts it in:
#
#   CODEMAN_INSTANCE=beta  → data dir ~/.codeman-beta + tmux socket codeman-beta
#   CODEMAN_PORT=5000      → listen on 5000 instead of 3000
#
# Result: the beta runs side-by-side with prod and can never discover/attach to
# prod's live tmux sessions or clobber prod's state.json. Override either var to
# run additional named instances, e.g. CODEMAN_INSTANCE=foo CODEMAN_PORT=5050.
#
# Usage:  ./scripts/run-beta.sh [extra `reverie web` flags]
# Build first (the beta runs the compiled dist):  npm run build

set -euo pipefail

export CODEMAN_INSTANCE="${CODEMAN_INSTANCE:-beta}"
export CODEMAN_PORT="${CODEMAN_PORT:-5000}"

DIST="$(cd "$(dirname "$0")/.." && pwd)/dist/index.js"
if [ ! -f "$DIST" ]; then
  echo "dist not found at $DIST — run 'npm run build' first." >&2
  exit 1
fi

echo "Starting beta Reverie: instance='$CODEMAN_INSTANCE' (~/.codeman-$CODEMAN_INSTANCE, -L codeman-$CODEMAN_INSTANCE) on port $CODEMAN_PORT"
exec node "$DIST" web "$@"
