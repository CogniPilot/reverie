# The console's fixed stdio handler. Building it does not enable any route.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-core" "reverie-contracts" "reverie-routes" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-route-handler";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-routes" "--bin" "reverie-route-handler" ];
  cargoTestFlags = [ "-p" "reverie-routes" ];
  doCheck = true;
  meta = {
    description = "Bounded native stdio handler for selected Reverie API routes";
    mainProgram = "reverie-route-handler";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
