# Keep this compatibility interpreter private to the laptop image. The site,
# broker, store interpreter and external Python installations are untouched.
{ pkgs, memory }:
let
  python = pkgs.python3;
  interpreter = pkgs.runCommand "reverie-worker-python-${python.version}" {
    nativeBuildInputs = [ pkgs.patchelf ];
  } ''
    mkdir -p "$out/bin"
    cp -L ${python.interpreter} "$out/bin/${python.executable}"
    chmod 755 "$out/bin/${python.executable}"
    # DT_RUNPATH covers direct dependencies only. Binary wheels load their own
    # extension DSOs, whose common C++/zlib dependencies need a transitive path.
    oldPath=$(patchelf --print-rpath "$out/bin/${python.executable}")
    libraryPath="${pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib pkgs.zlib ]}"
    if [ -n "$oldPath" ]; then libraryPath="$libraryPath:$oldPath"; fi
    patchelf --force-rpath --set-rpath "$libraryPath" "$out/bin/${python.executable}"
    for directory in lib include share; do
      if [ -d ${python}/"$directory" ]; then
        ln -s ${python}/"$directory" "$out/$directory"
      fi
    done
    ln -s ${python.executable} "$out/bin/python3"
    ln -s ${python.executable} "$out/bin/python"
  '';
  wheelPython = python // { interpreter = "${interpreter}/bin/${python.executable}"; };
in
assert pkgs.stdenv.hostPlatform.isLinux;
assert memory.python.outPath == python.outPath;
memory.override {
  python = wheelPython;
  postBuild = ''
    # The pytest entry points otherwise keep their original store shebang.
    # Route both aliases through this environment's compatibility interpreter.
    for command in pytest py.test; do
      if [ -e "$out/bin/$command" ]; then
        rm "$out/bin/$command"
        makeWrapper "$out/bin/${python.executable}" "$out/bin/$command" \
          --add-flags "-m pytest"
      fi
    done
  '';
}
