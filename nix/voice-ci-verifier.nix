{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-voice-ci" "reverie-kokoro" "reverie-speech" ];
  };
  fixtureFile = name: builtins.path {
    inherit name;
    path = (src.origSrc or src) + "/scripts/voice-ci/${name}";
  };
  source = pkgs.runCommand "reverie-voice-ci-source" {} ''
    mkdir -p "$out/scripts/voice-ci"
    cp -r ${workspace.source}/. "$out/"
    cp ${fixtureFile "fixtures.json"} "$out/scripts/voice-ci/fixtures.json"
    cp ${fixtureFile "whisper-model.json"} "$out/scripts/voice-ci/whisper-model.json"
  '';
  engine = import ./kokoro-engine.nix { inherit pkgs src; };
  whisper = pkgs.whisper-cpp.override { withSDL = false; };
in pkgs.rustPlatform.buildRustPackage (engine // {
  pname = "reverie-voice-ci";
  version = "0.1.0";
  src = source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-voice-ci" ];
  cargoTestFlags = [ "-p" "reverie-voice-ci" ];
  REVERIE_SPEECH_WHISPER = "${whisper}/bin/whisper-cli";
  REVERIE_SPEECH_FFMPEG = pkgs.lib.getExe' pkgs.ffmpeg-headless "ffmpeg";
  doCheck = true;
  meta = {
    description = "Native real-model speech fixture and voice acceptance verifier";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.unix;
    mainProgram = "reverie-voice-ci-verify";
  };
})
