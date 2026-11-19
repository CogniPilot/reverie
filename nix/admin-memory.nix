{ pkgs, src }:
let
  tools = import ./host-tools.nix { inherit pkgs src; };
in pkgs.runCommand "reverie-admin-memory" {
  disallowedRequisites = [ pkgs.python3 ];
  meta.mainProgram = "reverie-admin-memory";
} ''
  mkdir -p "$out/bin"
  ln -s ${tools}/bin/reverie-admin-memory "$out/bin/reverie-admin-memory"
  ln -s ${tools}/bin/reverie-admin-memory "$out/bin/reverie-context"
  ln -s ${tools}/bin/reverie-admin-memory "$out/bin/reverie-worker-store-maintenance"
  ln -s ${tools}/bin/reverie-admin-memory "$out/bin/reverie-sleep"
  ln -s ${tools}/bin/reverie-admin-memory "$out/bin/reverie-opencode"
  ln -s ${tools}/bin/reverie-admin-memory "$out/bin/reverie-opencode-bridge"
''
