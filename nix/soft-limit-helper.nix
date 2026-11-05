# Standalone native boundary: no Python interpreter, broker source, or runtime fallback.
{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-soft-limit-helper";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-soft-limit-helper" ];
  cargoTestFlags = [ "-p" "reverie-soft-limit-helper" ];
  REVERIE_TEST_SHELL = "${pkgs.bash}/bin/bash";
  doCheck = true;
  meta = {
    description = "Root-authorized, one-connection laptop soft memory limit helper";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-soft-limit-helper";
  };
}
