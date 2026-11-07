# Read-only resolver qualification graph; no program/DSO function executes.
{ pkgs }:
pkgs.runCommand "reverie-capsule-equal-origin-fixture" {
  nativeBuildInputs = [ pkgs.patchelf ];
} ''
  mkdir -p "$out/a" "$out/b"
  cp ${pkgs.stdenv.cc.bintools.dynamicLinker} "$out/a/libprivate.so"
  chmod u+w "$out/a/libprivate.so"
  patchelf --set-soname libprivate.so "$out/a/libprivate.so"
  cp "$out/a/libprivate.so" "$out/b/libprivate.so"
  printf X >> "$out/b/libprivate.so"
  cp ${pkgs.stdenv.cc.bintools.dynamicLinker} "$out/a/libsame.so"
  chmod u+w "$out/a/libsame.so"
  patchelf --set-soname libsame.so --add-needed libprivate.so --set-rpath '$ORIGIN' "$out/a/libsame.so"
  cp "$out/a/libsame.so" "$out/b/libsame.so"
  cp ${pkgs.stdenv.cc.bintools.dynamicLinker} "$out/a/root.so"
  chmod u+w "$out/a/root.so"
  patchelf --set-soname root.so --add-needed libsame.so --set-rpath '$ORIGIN' "$out/a/root.so"
  cp "$out/a/root.so" "$out/b/root.so"
  printf '%s\n' "$out" > "$out/closure"
''
