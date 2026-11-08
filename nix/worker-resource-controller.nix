# Fixed native controller executable. Runtime selection remains owned by the
# registered installation/consent flow; this build grants no host authority.
{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-worker-resource-controller";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-worker-resource-controller" ];
  cargoTestFlags = [ "-p" "reverie-worker-resource-controller" ];
  doCheck = true;
  meta = {
    description = "Native Docker worker-pool controller";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-worker-resource-controller";
  };
}
