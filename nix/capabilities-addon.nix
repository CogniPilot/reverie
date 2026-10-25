{ pkgs, src }:
pkgs.runCommand "reverie-capabilities-addon" { nativeBuildInputs = [ pkgs.esbuild ]; } ''
  mkdir -p "$out/lib"
  esbuild ${src}/apps/web/src/capabilities-standalone.ts \
    --bundle --platform=node --format=esm --target=node22 --outfile="$out/lib/capabilities.mjs"
''
