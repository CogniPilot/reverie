{ pkgs, src }:
let
  # Kokoro synthesizes audio with ONNX and uses only eSpeak phonemes.
  espeak = pkgs.espeak-ng.override { mbrolaSupport = false; };
  phonemes = pkgs.runCommandCC "reverie-kokoro-phonemes" {
    buildInputs = [ espeak ];
  } ''
    mkdir -p "$out/bin"
    cc -std=c17 -O2 -Wall -Wextra -Werror ${builtins.path {
      path = (src.origSrc or src) + "/crates/reverie-kokoro/espeak.c";
      name = "reverie-kokoro-espeak.c";
    }} -lespeak-ng -o "$out/bin/reverie-kokoro-phonemes"
  '';
in {
  REVERIE_KOKORO_ONNX = "${pkgs.onnxruntime}/lib/libonnxruntime.so";
  REVERIE_KOKORO_ESPEAK = "${espeak}/bin/espeak-ng";
  REVERIE_KOKORO_PHONEMES = "${phonemes}/bin/reverie-kokoro-phonemes";
  REVERIE_KOKORO_CURL = "${pkgs.curl}/bin/curl";
}
