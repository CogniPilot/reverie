{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-deployment";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
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
