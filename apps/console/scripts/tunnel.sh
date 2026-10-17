#!/usr/bin/env bash
# Cloudflare Tunnel manager for Codeman
# Usage: ./scripts/tunnel.sh [quick|named] [start|stop|status|url]
#
# Modes:
#   quick  — Quick tunnel with random trycloudflare.com URL (default)
#   named  — Named tunnel on a fixed hostname (requires setup, see below)
#
# Environment variables:
#   CLOUDFLARED_TUNNEL_NAME     — tunnel name (default: codeman)
#   CLOUDFLARED_TUNNEL_ID       — tunnel UUID (from: cloudflared tunnel list)
#   CODEMAN_TUNNEL_HOSTNAME     — public hostname (e.g. codeman.example.com)
#
# First-time named tunnel setup:
#   cloudflared tunnel login
#   cloudflared tunnel create <tunnel-name>
#   cloudflared tunnel route dns <tunnel-name> <hostname>
#   ./scripts/tunnel.sh named setup   # writes ~/.cloudflared/<tunnel-name>.yml
set -euo pipefail

QUICK_SERVICE="codeman-tunnel"
NAMED_SERVICE="codeman-tunnel-named"
TUNNEL_NAME="${CLOUDFLARED_TUNNEL_NAME:-codeman}"
TUNNEL_HOSTNAME="${CODEMAN_TUNNEL_HOSTNAME:-codeman.example.com}"
CODEMAN_PORT="3000"
LOG_FILE="$HOME/.codeman/tunnel.log"

# ── helpers ──────────────────────────────────────────────────────────────────

_require_cloudflared() {
  if ! command -v cloudflared &>/dev/null; then
    echo "Error: cloudflared not found. Install with: yay -S cloudflared" >&2
    exit 1
  fi
}

_cloudflared_bin() {
  command -v cloudflared
}

_install_service() {
  local svc_file="$1"
  local svc_name="$2"
  if ! systemctl --user cat "$svc_name" &>/dev/null 2>&1; then
    cp "$(dirname "$0")/$svc_file" "$HOME/.config/systemd/user/"
    systemctl --user daemon-reload
    echo "Service $svc_name installed."
  fi
}

_install_named_service() {
  if ! systemctl --user cat "$NAMED_SERVICE" &>/dev/null 2>&1; then
    # Generate service file with the configured tunnel name
    sed "s/codeman\.yml/$TUNNEL_NAME.yml/g; s/run codeman/run $TUNNEL_NAME/g" \
      "$(dirname "$0")/codeman-tunnel-named.service" \
      > "$HOME/.config/systemd/user/codeman-tunnel-named.service"
    systemctl --user daemon-reload
    echo "Service $NAMED_SERVICE installed (tunnel: $TUNNEL_NAME)."
  fi
}

# ── named tunnel setup ───────────────────────────────────────────────────────

_named_setup() {
  _require_cloudflared

  local creds_dir="$HOME/.cloudflared"
  local config_file="$creds_dir/$TUNNEL_NAME.yml"
  # Replace with your tunnel ID (from: cloudflared tunnel list)
  local tunnel_id="${CLOUDFLARED_TUNNEL_ID:-YOUR_TUNNEL_ID_HERE}"
  local creds_file="$creds_dir/$tunnel_id.json"

  if [ ! -f "$creds_file" ]; then
    echo "Credentials not found: $creds_file"
    echo "Run: cloudflared tunnel create $TUNNEL_NAME"
    exit 1
  fi

  cat > "$config_file" <<EOF
tunnel: $tunnel_id
credentials-file: $creds_file

ingress:
  - hostname: $TUNNEL_HOSTNAME
    service: http://localhost:$CODEMAN_PORT
  - service: http_status:404
EOF

  echo "Config written to $config_file"
  echo "Tunnel ID: $tunnel_id"
  echo "Hostname:  $TUNNEL_HOSTNAME"
  echo ""
  echo "Next steps:"
  echo "  1. Add Cloudflare Access policy for $TUNNEL_HOSTNAME (Zero Trust dashboard)"
  echo "  2. ./scripts/tunnel.sh named start"
}

# ── quick mode ───────────────────────────────────────────────────────────────

_quick_start() {
  if ! systemctl --user is-active "$QUICK_SERVICE" &>/dev/null; then
    _install_service "codeman-tunnel.service" "$QUICK_SERVICE"
    systemctl --user start "$QUICK_SERVICE"
    echo "Quick tunnel starting... waiting for URL"
    sleep 6
  fi
  local url
  url=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1)
  if [ -n "$url" ]; then
    echo "$url"
  else
    echo "URL not ready yet, try: $0 quick url"
  fi
}

_quick_stop() {
  systemctl --user stop "$QUICK_SERVICE"
  echo "Quick tunnel stopped"
}

_quick_status() {
  systemctl --user status "$QUICK_SERVICE" --no-pager 2>&1 | head -10
  echo ""
  echo "URL:"
  grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1
}

_quick_url() {
  grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | tail -1
}

# ── named mode ───────────────────────────────────────────────────────────────

_named_start() {
  _require_cloudflared
  if [ ! -f "$HOME/.cloudflared/$TUNNEL_NAME.yml" ]; then
    echo "Config not found. Run: $0 named setup"
    exit 1
  fi
  if ! systemctl --user is-active "$NAMED_SERVICE" &>/dev/null; then
    _install_named_service
    systemctl --user start "$NAMED_SERVICE"
    echo "Named tunnel starting..."
    sleep 3
  fi
  echo "https://$TUNNEL_HOSTNAME"
}

_named_stop() {
  systemctl --user stop "$NAMED_SERVICE"
  echo "Named tunnel stopped"
}

_named_status() {
  systemctl --user status "$NAMED_SERVICE" --no-pager 2>&1 | head -10
  echo ""
  echo "URL: https://$TUNNEL_HOSTNAME"
}

_named_enable() {
  _install_named_service
  systemctl --user enable "$NAMED_SERVICE"
  echo "Named tunnel enabled at boot."
}

_named_disable() {
  systemctl --user disable "$NAMED_SERVICE"
  echo "Named tunnel disabled."
}

# ── dispatch ─────────────────────────────────────────────────────────────────

MODE="${1:-quick}"
CMD="${2:-start}"

case "$MODE" in
  quick)
    case "$CMD" in
      start)  _quick_start ;;
      stop)   _quick_stop ;;
      status) _quick_status ;;
      url)    _quick_url ;;
      *) echo "Usage: $0 quick [start|stop|status|url]"; exit 1 ;;
    esac
    ;;
  named)
    case "$CMD" in
      start)   _named_start ;;
      stop)    _named_stop ;;
      status)  _named_status ;;
      url)     echo "https://$TUNNEL_HOSTNAME" ;;
      setup)   _named_setup ;;
      enable)  _named_enable ;;
      disable) _named_disable ;;
      *) echo "Usage: $0 named [start|stop|status|url|setup|enable|disable]"; exit 1 ;;
    esac
    ;;
  # backward compat: no mode prefix → quick tunnel
  start)  _quick_start ;;
  stop)   _quick_stop ;;
  status) _quick_status ;;
  url)    _quick_url ;;
  *)
    echo "Usage: $0 [quick|named] [start|stop|status|url]"
    echo "       $0 named setup    # first-time named tunnel configuration"
    echo "       $0 named enable   # start at boot"
    exit 1
    ;;
esac
