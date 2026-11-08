{ pkgs, src }:
let
  # Only this package's crate closure, so an unrelated change keeps its cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-contracts" "reverie-core" "reverie-diagnostics" "reverie-host" "reverie-http" "reverie-python-regex" "reverie-store" "reverie-worker-child" ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-worker-child";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-worker-child" ];
  cargoTestFlags = [ "-p" "reverie-worker-child" ];
  doCheck = true;
  meta = {
    description = "Fixed-purpose native in-worker launch record and pane lifecycle";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
