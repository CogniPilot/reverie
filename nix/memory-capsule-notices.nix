# Preserve the qualified Console's dependency notices in its module tree and
# carry the separately supplied native/runtime upstream license texts too.
{ pkgs, native }:
pkgs.runCommand "reverie-memory-capsule-notices" {
  nativeBuildInputs = [ pkgs.gnutar pkgs.xz ];
} ''
  mkdir -p "$out/native" "$out/node" "$out/glibc" "$out/gcc"
  cp -r ${native}/share/doc/reverie-memory-guest/. "$out/native/"
  tar -xOf ${pkgs.nodejs-slim_22.src} --wildcards '*/LICENSE' > "$out/node/LICENSE"
  tar -xOf ${pkgs.glibc.src} --wildcards '*/COPYING' > "$out/glibc/COPYING"
  tar -xOf ${pkgs.glibc.src} --wildcards '*/COPYING.LIB' > "$out/glibc/COPYING.LIB"
  tar -xOf ${pkgs.gcc.cc.src} --wildcards '*/COPYING3' > "$out/gcc/COPYING3"
  tar -xOf ${pkgs.gcc.cc.src} --wildcards '*/COPYING.RUNTIME' > "$out/gcc/COPYING.RUNTIME"
''
