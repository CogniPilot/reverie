{ pkgs, python }:
pkgs.runCommand "reverie-worker-python-runtime-check" {
  nativeBuildInputs = [ pkgs.stdenv.cc pkgs.patchelf ];
  buildInputs = [ pkgs.zlib ];
} ''
  unset LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT PYTHONPATH PYTHONHOME
  export PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1
  cat > wheel-runtime.cc <<'CPP'
  #include <string>
  #include <zlib.h>
  extern "C" int wheel_runtime_probe() {
    std::string input(42, 'x');
    unsigned char output[128];
    uLongf length = sizeof(output);
    return compress2(output, &length,
      reinterpret_cast<const unsigned char *>(input.data()), input.size(),
      Z_BEST_SPEED) == Z_OK ? static_cast<int>(input.size()) : -1;
  }
  CPP
  c++ -shared -fPIC wheel-runtime.cc -o wheel-runtime.so -lz
  # Exercise a wheel-like DSO that does not carry Nix store library paths.
  patchelf --remove-rpath wheel-runtime.so
  patchelf --print-needed wheel-runtime.so > needed.txt
  grep -Fx libstdc++.so.6 needed.txt
  grep -Fx libz.so.1 needed.txt
  test -z "$(patchelf --print-rpath wheel-runtime.so)"
  cat > probe.py <<'PY'
  import ctypes, os, sys
  assert not any(k in os.environ for k in ('LD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_AUDIT'))
  assert os.readlink('/proc/self/exe') == '${python.python.interpreter}'
  library = ctypes.CDLL(sys.argv[1])
  library.wheel_runtime_probe.restype = ctypes.c_int
  assert library.wheel_runtime_probe() == 42
  PY
  library="$PWD/wheel-runtime.so"
  ${python}/bin/python -I -B probe.py "$library"
  ${python}/bin/python3 -I -B probe.py "$library"
  ${python}/bin/python3 -I -B -m venv venv
  venv/bin/python -I -B -m pip --version
  venv/bin/python -I -B probe.py "$library"
  cat > test_wheel_runtime.py <<PY
  import ctypes, os
  def test_binary_extension_dependencies():
      assert 'LD_LIBRARY_PATH' not in os.environ
      assert os.readlink('/proc/self/exe') == '${python.python.interpreter}'
      library = ctypes.CDLL('$library')
      library.wheel_runtime_probe.restype = ctypes.c_int
      assert library.wheel_runtime_probe() == 42
  PY
  ${python}/bin/pytest -q -p no:cacheprovider test_wheel_runtime.py
  ${python}/bin/py.test -q -p no:cacheprovider test_wheel_runtime.py
  mkdir -p "$out"
  cp wheel-runtime.cc wheel-runtime.so needed.txt probe.py test_wheel_runtime.py "$out/"
''
