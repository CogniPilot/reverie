{ pkgs, kokoro, voiceVerifier, laptopTools }:
let
  kokoroPins = builtins.fromJSON (builtins.readFile ../crates/reverie-kokoro/model-files.json);
  whisperModel = pkgs.fetchurl (builtins.fromJSON (builtins.readFile ../scripts/voice-ci/whisper-model.json));
  kokoroModel = pkgs.fetchurl kokoroPins.model;
  kokoroVoices = pkgs.fetchurl kokoroPins.voices;
in pkgs.mkShell {
  packages = [
    kokoro
    voiceVerifier
    laptopTools
    pkgs.nodejs_22 pkgs.chromium pkgs.git pkgs.coreutils pkgs.bash (pkgs.lib.getBin pkgs.util-linux)
  ];
  shellHook = ''
    export CHROMIUM_PATH=${pkgs.chromium}/bin/chromium
    export REVERIE_VOICE_CI_WHISPER_MODEL=${whisperModel}
    export REVERIE_VOICE_CI_KOKORO_MODEL=${kokoroModel}
    export REVERIE_VOICE_CI_KOKORO_VOICES=${kokoroVoices}
  '';
}
