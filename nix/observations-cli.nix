{ pkgs, src }:
let
  # Only this package's crate closure, so an unrelated change keeps its cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-contracts" "reverie-core" "reverie-observations" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-observations";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-observations" ];
  cargoTestFlags = [ "-p" "reverie-observations" ];
  doCheck = true;
  # The USER units' fixed systemctl, baked into reverie-observations.
  REVERIE_SYSTEMCTL = "${pkgs.systemd}/bin/systemctl";
  meta = {
    description = "Native host resource collector, USER observations, resource history reader, collector state initializer and prune receipts";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-resource-history";
  };
}
