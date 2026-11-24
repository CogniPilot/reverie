{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [
      "reverie-backend-cli" "reverie-contracts" "reverie-core" "reverie-diagnostics"
      "reverie-host" "reverie-http" "reverie-python-regex" "reverie-store" "reverie-worker-client"
    ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-backend-cli";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-backend-cli" ];
  cargoTestFlags = [ "-p" "reverie-backend-cli" ];
  env.REVERIE_FIXED_BACKEND_CURL = "${pkgs.curl}/bin/curl";
  disallowedRequisites = [ pkgs.python3 ];
  doCheck = builtins.getEnv "REVERIE_FAST_BUILD" != "1";
  meta = {
    description = "Launch the harness and model selected by the current Reverie session";
    mainProgram = "reverie-backend";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
