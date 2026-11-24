# Candidate only. Building this entry point never selects a service or a route.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-core" "reverie-contracts" "reverie-diagnostics" "reverie-front" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-front";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-front" "--bin" "reverie-front" ];
  cargoTestFlags = [ "-p" "reverie-front" ];
  doCheck = true;
  meta = {
    description = "Native listener and child supervisor for the Reverie console";
    mainProgram = "reverie-front";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
