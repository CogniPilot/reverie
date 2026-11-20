# Immutable agent CLI, bundled independently of the office website.
{ pkgs, src }:
let
  producer = import ./worker-client-capsule-producer.nix { inherit pkgs src; };
  node = pkgs.nodejs-slim_22;
  entry = import ./worker-client-entry.nix { inherit pkgs src; };
  bundle = import ./worker-client-bundle.nix { inherit pkgs src; };
  notices = pkgs.runCommand "reverie-worker-client-notices" {
    nativeBuildInputs = [ pkgs.gnutar pkgs.xz ];
  } ''
    mkdir -p "$out/runtime/node" "$out/runtime/glibc" "$out/runtime/gcc"
    cp -r ${bundle}/notices/. "$out/"
    tar -xOf ${node.src} --wildcards '*/LICENSE' > "$out/runtime/node/LICENSE"
    tar -xOf ${pkgs.glibc.src} --wildcards '*/COPYING' > "$out/runtime/glibc/COPYING"
    tar -xOf ${pkgs.glibc.src} --wildcards '*/COPYING.LIB' > "$out/runtime/glibc/COPYING.LIB"
    tar -xOf ${pkgs.gcc.cc.src} --wildcards '*/COPYING3' > "$out/runtime/gcc/COPYING3"
    tar -xOf ${pkgs.gcc.cc.src} --wildcards '*/COPYING.RUNTIME' > "$out/runtime/gcc/COPYING.RUNTIME"
  '';
  closure = pkgs.closureInfo { rootPaths = [ node ]; };
in pkgs.runCommand "reverie-worker-client-capsule" {
  nativeBuildInputs = [ producer ];
  preferLocalBuild = true;
  passthru = {
    prefix = "/opt/reverie-worker-client";
    executable = "/opt/reverie-worker-client/bin/reverie";
    manifest = "/opt/reverie-worker-client/manifest.json";
  };
} ''
  reverie-worker-client-capsule \
    --node ${node}/bin/node --entry ${entry}/bin/reverie-worker-client-entry --bundle ${bundle}/agent.mjs --legal ${bundle}/agent.mjs.LEGAL.txt \
    --hooks ${bundle}/claude-hooks.json --notices ${notices} --closure ${closure}/store-paths \
    --patchelf ${pkgs.patchelf}/bin/patchelf --readelf ${pkgs.binutils}/bin/readelf --output "$out"
''
