{ pkgs, src }:
let
  inherit (pkgs) lib;
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-speech" ];
  };
  whisper = pkgs.whisper-cpp.override {
    withSDL = false;
    cudaSupport = false;
    rocmSupport = false;
  };
  # Build the upstream standalone C++ frontend against the same system
  # libraries used by Kokoro. The Python bindings and training build stay out.
  piper = pkgs.stdenv.mkDerivation rec {
    pname = "reverie-piper-native";
    version = "1.8.0";
    src = pkgs.fetchurl {
      url = "https://github.com/OHF-Voice/piper1-gpl/archive/refs/tags/v${version}.tar.gz";
      hash = "sha256-CiKYemFX8U4vt89KpwK1R0Z/0ESL6p8jOr1QPD/0oOE=";
    };
    sourceRoot = "piper1-gpl-${version}/libpiper";
    nativeBuildInputs = [ pkgs.cmake pkgs.ninja ];
    cmakeFlags = [ "-DCMAKE_INSTALL_RPATH=${builtins.placeholder "out"}/lib" ];
    buildInputs = [ pkgs.espeak-ng pkgs.onnxruntime ];
    postPatch = ''
      sed -i '/^include(ExternalProject)/,/^# ---- onnxruntime ---/{ /^# ---- onnxruntime ---/!d; }' CMakeLists.txt
      sed -i '/^# Copy espeak-ng-data/,/^# Testing/{ /^# Testing/!d; }' CMakeLists.txt
      substituteInPlace CMakeLists.txt \
        --replace-fail 'add_dependencies(piper espeak_ng_external)' "" \
        --replace-fail '${"$"}{ESPEAKNG_INSTALL_DIR}/include' '${lib.getDev pkgs.espeak-ng}/include' \
        --replace-fail '${"$"}{ESPEAKNG_STATIC_LIB}' '${lib.getLib pkgs.espeak-ng}/lib/libespeak-ng.so' \
        --replace-fail '${"$"}{UCD_STATIC_LIB}' ""
    '';
    postInstall = ''
      ln -s ${pkgs.espeak-ng}/share/espeak-ng-data "$out/bin/espeak-ng-data"
      mkdir -p "$out/share/licenses/reverie-piper-native"
      cp "$NIX_BUILD_TOP/piper1-gpl-${version}/COPYING" "$out/share/licenses/reverie-piper-native/"
    '';
    meta.license = lib.licenses.gpl3Only;
  };
in
assert pkgs.stdenv.hostPlatform.isLinux;
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-speech";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-speech" ];
  cargoTestFlags = [ "-p" "reverie-speech" ];
  REVERIE_SPEECH_WHISPER = "${whisper}/bin/whisper-cli";
  REVERIE_SPEECH_FFMPEG = lib.getExe' pkgs.ffmpeg-headless "ffmpeg";
  REVERIE_SPEECH_PIPER = "${piper}/bin/piper_exe";
  disallowedRequisites = [ pkgs.python3 ];
  postInstall = ''
    mkdir -p "$out/share/doc/reverie-speech"
    cp ${builtins.path { path = (src.origSrc or src) + "/THIRD_PARTY_NOTICES.md"; name = "reverie-speech-notices"; }} "$out/share/doc/reverie-speech/THIRD_PARTY_NOTICES.md"
  '';
  passthru = { inherit piper whisper; ffmpeg = pkgs.ffmpeg-headless.bin; };
}
