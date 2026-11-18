{ pkgs, src }:
let
  phonemes = pkgs.runCommandCC "reverie-kokoro-phonemes" {
    buildInputs = [ pkgs.espeak-ng ];
  } ''
    mkdir -p "$out/bin"
    cc -std=c17 -O2 -Wall -Wextra -Werror ${builtins.path {
      path = (src.origSrc or src) + "/crates/reverie-kokoro/espeak.c";
      name = "reverie-kokoro-espeak.c";
    }} -lespeak-ng -o "$out/bin/reverie-kokoro-phonemes"
  '';
in {
  REVERIE_KOKORO_ONNX = "${pkgs.onnxruntime}/lib/libonnxruntime.so";
  REVERIE_KOKORO_ESPEAK = "${pkgs.espeak-ng}/bin/espeak-ng";
  REVERIE_KOKORO_PHONEMES = "${phonemes}/bin/reverie-kokoro-phonemes";
  REVERIE_KOKORO_CURL = "${pkgs.curl}/bin/curl";
}
