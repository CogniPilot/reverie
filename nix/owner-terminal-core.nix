{ pkgs, src }:
# Inert source bundle only. No service, listener, issuer, entitlement, route or H.
pkgs.runCommand "reverie-owner-terminal-core" {
  nativeBuildInputs = [ pkgs.python3 pkgs.nodejs_22 ];
} ''
  mkdir -p "$out/lib/reverie-owner-terminal" "$out/share/reverie-owner-terminal"
  cp ${src}/python/reverie/{human_shell_capabilities,human_terminal_protocol,owner_terminal_bootstrap,owner_terminal_channel,owner_terminal_ledger_service}.py "$out/lib/reverie-owner-terminal/"
  cp ${src}/apps/web/scripts/connect-owner-terminal.mjs "$out/share/reverie-owner-terminal/"
  cp ${src}/apps/web/src/{owner-laptop-terminal-authority,owner-ledger-bridge}.ts "$out/share/reverie-owner-terminal/"
  cp ${src}/docs/owner-terminal-core.md "$out/share/reverie-owner-terminal/INTEGRATION.md"
  PYTHONPATH="$out/lib/reverie-owner-terminal" python3 -B -c 'import human_shell_capabilities, human_terminal_protocol, owner_terminal_channel, owner_terminal_bootstrap, owner_terminal_ledger_service'
  node --check "$out/share/reverie-owner-terminal/connect-owner-terminal.mjs"
''
