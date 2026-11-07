{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-observations";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-observations" ];
  cargoTestFlags = [ "-p" "reverie-observations" ];
  doCheck = true;
  meta = {
    description = "Native bounded USER resource history reader";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-resource-history";
  };
}
