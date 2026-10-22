#!/usr/bin/env bash
# Install Reverie's complete application through the monorepo's Nix flake.
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    cat <<'HELP'
Install Reverie from a local monorepo checkout:
  nix profile add .#default

Run apps/console/install.sh without arguments to install that checkout.
The installer does not activate a service. Start the application with reverie web.
Build the container from the repository root with nix build .#dockerImage.
HELP
    exit 0
fi
if [[ $# -ne 0 ]]; then
    echo "Use --help for the Nix installation commands." >&2
    exit 2
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(CDPATH= cd -- "$script_dir/../.." && pwd -P)"
if [[ ! -f "$repo_root/flake.nix" || ! -d "$repo_root/apps/console" ]]; then
    echo "Run this script from a Reverie monorepo checkout. See https://github.com/jgoppert/reverie." >&2
    exit 1
fi
if ! command -v nix >/dev/null 2>&1; then
    echo "Install Nix first, then run: nix profile add path:$repo_root#default" >&2
    exit 1
fi
exec nix profile add "path:$repo_root#default"
