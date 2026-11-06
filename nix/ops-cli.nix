{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-ops-cli";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-ops-cli" ];
  cargoTestFlags = [ "-p" "reverie-ops-cli" ];
  doCheck = true;
  meta = {
    description = "Native structured OPS client for the installed Office API";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.unix;
    mainProgram = "reverie-ops";
  };
}
