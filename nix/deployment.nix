{ pkgs, src }:
let
  # Only this package's crate closure, so an unrelated change keeps its cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-contracts" "reverie-core" "reverie-diagnostics" "reverie-host" "reverie-http" "reverie-python-regex" "reverie-store" "reverie-deployment" ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-deployment";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-deployment" ];
  cargoTestFlags = [ "-p" "reverie-deployment" ];
  nativeCheckInputs = [ pkgs.gnutar pkgs.attr pkgs.acl ];
  REVERIE_DEPLOYMENT_TAR = "${pkgs.gnutar}/bin/tar";
  REVERIE_DEPLOYMENT_GETFATTR = "${pkgs.attr}/bin/getfattr";
  REVERIE_DEPLOYMENT_GETFACL = "${pkgs.acl}/bin/getfacl";
  REVERIE_DEPLOYMENT_COPY = "${pkgs.coreutils}/bin/cp";
  doCheck = true;
  meta = {
    description = "Registered console deployment preview, verified snapshot, apply and rollback API";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-deployment";
  };
}
