{ pkgs, kokoro }:
let
  whisperModel = pkgs.fetchurl {
    url = "https://openaipublic.azureedge.net/main/whisper/models/d3dd57d32accea0b295c96e26691aa14d8822fac7d9d27d5dc00b4ca2826dd03/tiny.en.pt";
    sha256 = "d3dd57d32accea0b295c96e26691aa14d8822fac7d9d27d5dc00b4ca2826dd03";
  };
  kokoroModel = pkgs.fetchurl {
    url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx";
    sha256 = "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5";
  };
  kokoroVoices = pkgs.fetchurl {
    url = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";
    sha256 = "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d";
  };
in pkgs.mkShell {
  packages = [
    (pkgs.python3.withPackages (ps: [ ps.openai-whisper ps.numpy kokoro.kokoro ]))
    pkgs.nodejs_22 pkgs.chromium pkgs.git pkgs.ffmpeg-headless pkgs.espeak-ng
    pkgs.coreutils pkgs.bash (pkgs.lib.getBin pkgs.util-linux)
  ];
  shellHook = ''
    export CHROMIUM_PATH=${pkgs.chromium}/bin/chromium
    export PHONEMIZER_ESPEAK_LIBRARY=${pkgs.espeak-ng}/lib/libespeak-ng.so
    export REVERIE_VOICE_CI_WHISPER_MODEL=${whisperModel}
    export REVERIE_VOICE_CI_KOKORO_MODEL=${kokoroModel}
    export REVERIE_VOICE_CI_KOKORO_VOICES=${kokoroVoices}
    export OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2
    export PYTHONPATH="$PWD/python''${PYTHONPATH:+:$PYTHONPATH}"
  '';
}
