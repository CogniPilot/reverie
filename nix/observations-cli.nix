{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-observations";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
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
