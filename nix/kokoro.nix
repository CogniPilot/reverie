{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-kokoro" ];
  };
  espeakAdapter = pkgs.runCommandCC "reverie-kokoro-phonemes" {
    buildInputs = [ pkgs.espeak-ng ];
  } ''
    mkdir -p "$out/bin"
    cc -std=c17 -O2 -Wall -Wextra -Werror ${builtins.path {
      path = (src.origSrc or src) + "/crates/reverie-kokoro/espeak.c";
      name = "reverie-kokoro-espeak.c";
    }} -lespeak-ng -o "$out/bin/reverie-kokoro-phonemes"
  '';
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-kokoro";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-kokoro" ];
  cargoTestFlags = [ "-p" "reverie-kokoro" ];
  REVERIE_KOKORO_ONNX = "${pkgs.onnxruntime}/lib/libonnxruntime.so";
  REVERIE_KOKORO_ESPEAK = "${pkgs.espeak-ng}/bin/espeak-ng";
  REVERIE_KOKORO_PHONEMES = "${espeakAdapter}/bin/reverie-kokoro-phonemes";
  REVERIE_KOKORO_CURL = "${pkgs.curl}/bin/curl";
  postInstall = ''
    mkdir -p "$out/share/licenses/reverie-kokoro"
    cp crates/reverie-kokoro/LICENSE-kokoro-onnx "$out/share/licenses/reverie-kokoro/"
  '';
  meta = {
    description = "Local Kokoro speech service using native ONNX Runtime and eSpeak NG";
    mainProgram = "reverie-kokoro";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
