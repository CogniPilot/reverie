{ pkgs, src }:
# reverie-deployment from the shared build in host-tools.nix, which compiles reverie-host once for several tools.
let
  tools = import ./host-tools.nix { inherit pkgs src; };
in
pkgs.runCommand "reverie-deployment-0.1.0" {
  meta = {
    description = "Registered console deployment preview, verified snapshot, apply and rollback API";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-deployment";
  };
} ''
  mkdir -p "$out/bin"
  ln -s ${tools}/bin/reverie-deployment "$out/bin/reverie-deployment"
''
