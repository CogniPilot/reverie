{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-worker-child";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-worker-child" ];
  cargoTestFlags = [ "-p" "reverie-worker-child" ];
  doCheck = true;
  meta = {
    description = "Fixed-purpose native in-worker launch record and pane lifecycle";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
