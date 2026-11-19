{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-image-check" ];
  };
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-image-check";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-image-check" ];
  cargoTestFlags = [ "-p" "reverie-image-check" ];
  meta = {
    description = "Scan saved Docker images before publication";
    mainProgram = "reverie-image-check";
    license = pkgs.lib.licenses.mit;
  };
}
