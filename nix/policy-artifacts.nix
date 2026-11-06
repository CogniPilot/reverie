# Build-only producer, using the shared selected-workspace/locked-input owner.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-core" "reverie-contracts" "reverie-policy-artifacts" ];
  };
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-policy-artifacts";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-policy-artifacts" ];
  cargoTestFlags = [ "-p" "reverie-policy-artifacts" ];
  doCheck = true;
  meta = {
    description = "Build-only fixed task perf seccomp artifact producer";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-policy-artifacts";
  };
}
