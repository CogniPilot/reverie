{ pkgs, src }:
let
  original = src.origSrc or src;
  keep = import ./source-filter-policy.nix { inherit (pkgs) lib; };
  source = builtins.path {
    path = original;
    name = "reverie-worker-client-source";
    filter = path: type:
      let rel = pkgs.lib.removePrefix ((toString original) + "/") (toString path); in
      builtins.elem rel [
        "THIRD_PARTY_NOTICES.md" "apps" "apps/web" "apps/web/LICENSE"
        "apps/web/package.json" "apps/web/package-lock.json" "apps/web/tsconfig.json"
        "apps/web/scripts" "apps/web/scripts/build-worker-client.mts" "apps/web/src"
      ] || (pkgs.lib.hasPrefix "apps/web/src/" rel
        && rel != "apps/web/src/web/public"
        && keep rel type);
  };
  lock = builtins.fromJSON (builtins.readFile (original + "/apps/web/package-lock.json"));
  # The bundled client imports these npm packages. esbuild rejects unresolved imports.
  names = [ "chalk" "commander" "zod" ];
  package = {
    name = "reverie-worker-client";
    version = "1";
    dependencies = pkgs.lib.genAttrs names (name: lock.packages."node_modules/${name}".version);
  };
  packageLock = {
    inherit (lock) lockfileVersion;
    inherit (package) name version;
    packages = { "" = package; } // pkgs.lib.genAttrs (map (name: "node_modules/${name}") names)
      (key: lock.packages.${key});
  };
  modules = pkgs.importNpmLock.buildNodeModules {
    inherit package packageLock;
    nodejs = pkgs.nodejs_22;
    derivationArgs.npmFlags = [ "--ignore-scripts" ];
  };
  node = pkgs.nodejs-slim_22;
in pkgs.runCommand "reverie-worker-client-bundle" {} ''
  ${node}/bin/node --experimental-strip-types ${source}/apps/web/scripts/build-worker-client.mts \
    --entry ${source}/apps/web/src/worker-client-cli.ts \
    --esbuild ${pkgs.esbuild}/bin/esbuild --node ${node}/bin/node --source ${source} \
    --modules ${modules}/node_modules --output "$out"
''
