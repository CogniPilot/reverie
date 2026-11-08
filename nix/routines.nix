{ pkgs, src }:
let
  # Only this package's crate closure, so an unrelated change keeps its cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-routines" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-routines";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
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
