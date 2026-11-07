{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-voice-ci";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-voice-ci" ];
  cargoTestFlags = [ "-p" "reverie-voice-ci" ];
  doCheck = true;
  meta = {
    description = "Native acceptance verifier for captured voice-CI audio";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.unix;
    mainProgram = "reverie-voice-ci-verify";
  };
}
