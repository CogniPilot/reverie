{ pkgs, src }:
# Both commands share one host-tools build.
let
  tools = import ./host-tools.nix { inherit pkgs src; };
in
pkgs.runCommand "reverie-lease-0.1.0" {
  meta = {
    description = "Native lease and task workspace commands";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-lease";
  };
} ''
  mkdir -p "$out/bin"
  ln -s ${tools}/bin/reverie-lease ${tools}/bin/reverie-workspaces "$out/bin/"
''
