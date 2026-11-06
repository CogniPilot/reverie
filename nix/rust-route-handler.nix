# The console's fixed stdio handler. Building it does not enable any route.
{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-route-handler";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
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
