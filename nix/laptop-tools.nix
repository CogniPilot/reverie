{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-laptop-tools";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-laptop-tools" ];
  cargoTestFlags = [ "-p" "reverie-laptop-tools" ];
  REVERIE_TEST_MKFIFO = "${pkgs.coreutils}/bin/mkfifo";
  REVERIE_TEST_SHELL = "${pkgs.bash}/bin/bash";
  doCheck = true;
  meta = {
    description = "Native bounded defaults for laptop Cargo builds";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
