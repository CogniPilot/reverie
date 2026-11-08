# reverie-mux: list, inspect, attach and kill the console's tmux sessions from a terminal.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-mux" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-mux";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-mux" ];
  cargoTestFlags = [ "-p" "reverie-mux" ];
  doCheck = true;
  meta = {
    description = "List, inspect, attach and kill the Reverie console's tmux sessions";
    mainProgram = "reverie-mux";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
