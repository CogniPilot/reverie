# Only these two helpers may gain initial-namespace ID-mapping capabilities.
# Their interpreter, libraries and plugin fallback must not use writable /nix.
{ pkgs }:
pkgs.runCommand "reverie-worker-idmap" {
  nativeBuildInputs = [ pkgs.python3 pkgs.patchelf ];
  preferLocalBuild = true;
  allowSubstitutes = false;
} ''
  ${pkgs.python3}/bin/python3 ${./worker-idmap.py} \
    --shadow ${pkgs.shadow} --output "$out" --patchelf ${pkgs.patchelf}/bin/patchelf
''
