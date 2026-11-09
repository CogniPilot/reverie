# Build-only producer, using the shared selected-workspace/locked-input owner.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-core" "reverie-contracts" "reverie-elf-bundle" "reverie-policy-artifacts" ];
  };
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-policy-artifacts";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  env = {
    REVERIE_FIXED_BUILD_GNUTAR = "${pkgs.gnutar}/bin/tar";
    REVERIE_FIXED_BUILD_TIMEOUT = "${pkgs.coreutils}/bin/timeout";
    REVERIE_FIXED_BUILD_GZIP_PATH = "${pkgs.gzip}/bin";
  };
  cargoBuildFlags = [ "-p" "reverie-policy-artifacts" ];
  cargoTestFlags = [ "-p" "reverie-policy-artifacts" ];
  doCheck = true;
  meta = {
    description = "Build-only fixed Docker namespace and task perf seccomp producer";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-policy-artifacts";
  };
}
