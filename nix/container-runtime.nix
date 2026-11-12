{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-container-runtime" "reverie-local-model" ];
  };
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-container-runtime";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-container-runtime" ];
  cargoTestFlags = [ "-p" "reverie-container-runtime" ];
  meta = {
    description = "Docker-owned Reverie website, inference and telemetry supervision";
    mainProgram = "reverie-container-runtime";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
