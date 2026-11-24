{ pkgs, src }:
let
  # Only this package's crate closure, so an unrelated change keeps its cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-contracts" "reverie-core" "reverie-http" "reverie-ops-cli" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-ops-cli";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-ops-cli" ];
  cargoTestFlags = [ "-p" "reverie-ops-cli" ];
  doCheck = builtins.getEnv "REVERIE_FAST_BUILD" != "1";
  meta = {
    description = "Native structured OPS client for the installed Office API";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.unix;
    mainProgram = "reverie-ops";
  };
}
