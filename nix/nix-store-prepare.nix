{ pkgs, src }:
let
  # Only this package's crate closure, so an unrelated change keeps its cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-contracts" "reverie-core" "reverie-diagnostics" "reverie-host" "reverie-http" "reverie-python-regex" "reverie-store" "reverie-nix-store-prepare" ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-nix-store-prepare";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-nix-store-prepare" ];
  cargoTestFlags = [ "-p" "reverie-nix-store-prepare" ];
  doCheck = true;
  meta = {
    description = "Fixed unprivileged guest bootstrap for a worker private Nix store";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
