{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-nix-store-prepare";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-nix-store-prepare" ];
  cargoTestFlags = [ "-p" "reverie-nix-store-prepare" ];
  doCheck = true;
  meta = {
    description = "Fixed unprivileged guest bootstrap for a worker private Nix store";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
