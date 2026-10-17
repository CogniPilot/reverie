#!/usr/bin/env bash
#
# span-codeman.sh — open a Codeman window stretched across ALL displays, so that
# in-page floating session panels can be dragged from one physical monitor to
# the other. Spawned by the header "multi-monitor" button (POST
# /api/system/span-displays), or run by hand at the desk.
#
# ── PREREQUISITE (one-time, manual) ──────────────────────────────────────────
# System Settings → Desktop & Dock → turn OFF "Displays have separate Spaces",
# then LOG OUT and back in. Until you do, macOS keeps every window on a single
# display and this script's window will clamp to one monitor instead of spanning.
# (Equivalent CLI: `defaults write com.apple.spaces spans-displays -bool true`,
#  still needs a re-login. Revert with `-bool false`.)
#
# Why a maximized --app window and not fullscreen: browser fullscreen is
# per-display and will NOT span. We size a windowed app to the union of all
# displays instead. macOS only.
#
# ── REMOTE CLIENT (Codeman server on another machine) ────────────────────────
# The header "multi-monitor" button spawns this script SERVER-SIDE, so it opens
# the window on the SERVER's displays and is gated to a macOS server. If your
# Codeman runs elsewhere (e.g. a headless Linux box reached over Tailscale) and
# YOUR monitors are on a Mac, the button can't help — the server can't open a
# window on your machine. Instead, run this script LOCALLY on the Mac and pass
# the remote URL as the argument:
#   ./span-codeman.sh "https://your-codeman.example.ts.net"
# The osascript/browser launch all happen on the Mac; only the page is served
# remotely, so the spanning window lands on your monitors. The "separate Spaces"
# prerequisite above still applies on the Mac.
#
set -euo pipefail

URL="${1:-http://localhost:5000}"

# Union rect of all displays in top-left-origin points — exactly what Chromium's
# --window-position/--window-size expect. Finder's desktop window bounds already
# encloses every monitor (and handles a monitor placed left/above via a negative
# origin), so no per-display math or coordinate flipping is needed.
bounds=$(osascript -e 'tell application "Finder" to get bounds of window of desktop')
X=$(echo "$bounds" | awk -F', *' '{print $1}')
Y=$(echo "$bounds" | awk -F', *' '{print $2}')
R=$(echo "$bounds" | awk -F', *' '{print $3}')
B=$(echo "$bounds" | awk -F', *' '{print $4}')
W=$((R - X))
H=$((B - Y))
echo "Display union: position ${X},${Y}  size ${W}x${H}"

# Pick a Chromium-family browser. Brave leads the list — plain Google Chrome
# bounced when launched this way on the desk machine (created its profile then
# exited without a window). Force a specific one with, e.g.,
# BROWSER="Google Chrome" ./span-codeman.sh
app="${BROWSER:-}"
if [ -z "$app" ]; then
  for c in "Brave Browser" "Google Chrome" "Google Chrome Beta" "Chromium" "Microsoft Edge"; do
    [ -x "/Applications/$c.app/Contents/MacOS/$c" ] && app="$c" && break
  done
fi
bin="/Applications/$app.app/Contents/MacOS/$app"
[ -n "$app" ] && [ -x "$bin" ] || { echo "No Chrome-family browser found (BROWSER='$app')" >&2; exit 1; }

# A dedicated, PER-BROWSER profile forces a FRESH instance — an already-running
# browser would hand the URL to itself and silently ignore the geometry flags.
# Per-browser so a Chrome-made profile can't confuse Brave (or vice-versa).
slug=$(echo "$app" | tr '[:upper:] ' '[:lower:]-')
profile="$HOME/.codeman-gesture-$slug"

echo "Browser: $bin"
echo "URL:     $URL"

# Detach so the caller (terminal / web server) isn't blocked for the window's life.
nohup "$bin" \
  --app="$URL" \
  --user-data-dir="$profile" \
  --window-position="${X},${Y}" \
  --window-size="${W},${H}" \
  --no-first-run \
  --no-default-browser-check \
  >/dev/null 2>&1 &

echo "Launched spanning window (pid $!)."
echo "If it filled only one monitor, the 'separate Spaces' prerequisite above"
echo "isn't active yet — toggle it off, log out/in, and re-run."
