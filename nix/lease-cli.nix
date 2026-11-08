{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-lease";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-lease-cli" ];
  cargoTestFlags = [ "-p" "reverie-lease-cli" ];
  doCheck = true;
  meta = {
    description = "Native lease command for disposable work directories";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-lease";
  };
}
