# The host local-model launcher; flake.nix wraps it with the llama.cpp build inputs.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-local-model" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-local-model";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-local-model" ];
  cargoTestFlags = [ "-p" "reverie-local-model" ];
  doCheck = true;
  meta = {
    description = "Run GGUF models on a host NVIDIA GPU or CPU through Nix-built llama.cpp";
    mainProgram = "reverie-local-model";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
