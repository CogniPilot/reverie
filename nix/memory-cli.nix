{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-memory-cli";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-memory-cli" ];
  cargoTestFlags = [ "-p" "reverie-memory-cli" ];
  nativeCheckInputs = [ pkgs.coreutils ];
  doCheck = true;
  meta = {
    description = "Native explicitly scoped memory and authenticated journal bridge candidate";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
