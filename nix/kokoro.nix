{ pkgs, memoryPackage }:
let
  ps = pkgs.python3Packages;
  phonemizer = ps.phonemizer.overridePythonAttrs (_: {
    version = "3.4.0";
    # 3.4 incorporates custom data-path support; the older Nix patches no longer apply.
    patches = [ ];
    src = pkgs.fetchPypi {
      pname = "phonemizer";
      version = "3.4.0";
      hash = "sha256-4TIxmAxQvGcewEZjeboCcmCtnWGSmVLYrpZls9DyUes=";
    };
  });
  kokoro = ps.buildPythonPackage {
    pname = "kokoro-onnx";
    version = "0.6.1";
    pyproject = true;
    src = pkgs.fetchPypi {
      pname = "kokoro_onnx";
      version = "0.6.1";
      hash = "sha256-e722bdU3dfcQiKmZmamu/a0kB0Da9UywlBDYux4pTjU=";
    };
    build-system = [ ps.hatchling ];
    dependencies = [ ps.numpy ps.onnxruntime phonemizer ];
    # Use Nix's espeak-ng instead of the loader wheel's bundled native library.
    pythonRemoveDeps = [ "espeakng-loader" ];
    postPatch = ''
      substituteInPlace src/kokoro_onnx/tokenizer.py \
        --replace-fail 'import espeakng_loader' "" \
        --replace-fail 'espeakng_loader.get_data_path()' '"${pkgs.espeak-ng}/share/espeak-ng-data"' \
        --replace-fail 'espeakng_loader.get_library_path()' '"${pkgs.espeak-ng}/lib/libespeak-ng.so"'
    '';
    pythonImportsCheck = [ "kokoro_onnx" ];
    meta.license = pkgs.lib.licenses.asl20;
  };
  python = pkgs.python3.withPackages (_: [ memoryPackage kokoro ]);
in pkgs.writeShellApplication {
  name = "reverie-kokoro";
  text = ''
    export OMP_NUM_THREADS="''${OMP_NUM_THREADS:-2}"
    export PHONEMIZER_ESPEAK_LIBRARY=${pkgs.espeak-ng}/lib/libespeak-ng.so
    exec ${python}/bin/python3 -m reverie.kokoro "$@"
  '';
  derivationArgs.passthru = { inherit python kokoro; };
}
