{ pkgs, src, console, ownerTerminalCore }:
let
  fixtures = builtins.path {
    path = (src.origSrc or src) + "/apps/web/test/fixtures/owner-terminal";
  };
in
pkgs.runCommand "reverie-owner-terminal-bridge-check" {
  nativeBuildInputs = [ pkgs.python3 ];
  OWN_TEST_NODE = "${pkgs.nodejs_22}/bin/node";
  OWNER_TERMINAL_TEST_DIST = "${console}/lib/reverie/dist";
  OWNER_TERMINAL_TEST_CONNECTOR = "${ownerTerminalCore}/share/reverie-owner-terminal/connect-owner-terminal.mjs";
  NIX_REVERIE_TEST_NODE_CUSTODY = "1";
} ''
  mkdir python
  ln -s ${ownerTerminalCore}/lib/reverie-owner-terminal python/reverie
  PYTHONPATH="$PWD/python" python3 -B ${fixtures}/test_bridge.py
  touch "$out"
''
