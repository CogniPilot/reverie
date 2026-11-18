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
''
