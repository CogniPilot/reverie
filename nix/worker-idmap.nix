# Only these two helpers may gain initial-namespace ID-mapping capabilities.
# Their interpreter, libraries and plugin fallback must not use writable /nix.
{ pkgs, artifacts ? import ./policy-artifacts.nix { inherit pkgs; src = ../.; } }:
let
  closure = pkgs.closureInfo { rootPaths = [ pkgs.shadow ]; };
in
pkgs.runCommand "reverie-worker-idmap" {
  preferLocalBuild = true;
  allowSubstitutes = false;
} ''
  ${artifacts}/bin/reverie-policy-artifacts idmap-image \
    --shadow ${pkgs.shadow} --output "$out" \
    --closure ${closure}/store-paths \
    --patchelf ${pkgs.patchelf}/bin/patchelf --readelf ${pkgs.binutils}/bin/readelf
''
