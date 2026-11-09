# Fixed native controller executable. Runtime selection remains owned by the
# registered installation/consent flow; this build grants no host authority.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [
      "reverie-worker-resource-controller" "reverie-host" "reverie-core"
      "reverie-contracts" "reverie-store" "reverie-http"
      "reverie-diagnostics" "reverie-python-regex"
    ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-worker-resource-controller";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
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
