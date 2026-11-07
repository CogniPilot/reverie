{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-routines";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-routines" ];
  cargoTestFlags = [ "-p" "reverie-routines" ];
  nativeBuildInputs = [ pkgs.makeWrapper ];
  doCheck = true;
  # Zones come from this tzdata unless the host sets TZDIR; the binary's bundled database is the last resort.
  postInstall = ''
    wrapProgram "$out/bin/reverie-routines" --set-default TZDIR ${pkgs.tzdata}/share/zoneinfo
  '';
  meta = {
    description = "Host routines tick: status reports, wake-up and wind-down calls";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-routines";
  };
}
