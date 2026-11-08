{ pkgs, src }:
let
  # Only this package's crate closure, so an unrelated change keeps its cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-contracts" "reverie-core" "reverie-diagnostics" "reverie-host" "reverie-http" "reverie-python-regex" "reverie-store" "reverie-lease-cli" ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-lease";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-lease-cli" ];
  cargoTestFlags = [ "-p" "reverie-lease-cli" ];
  doCheck = true;
  meta = {
    description = "Native lease command for disposable work directories";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-lease";
  };
}
