{ pkgs, src }:
let
  lib = pkgs.lib;
  original = src.origSrc or src;
  # Only the modules the client entry can import, so an edit to any other file
  # under apps/web/src leaves this source, the bundle and the capsule unchanged.
  # A module the scan misses is absent here and esbuild refuses the bundle.
  imported = map (file: "apps/web/src/${file}") (import ./typescript-import-closure.nix {
    inherit lib;
    root = original + "/apps/web/src";
    entry = "worker-client-cli.ts";
  });
  ancestors = file: let parts = lib.splitString "/" file; in
    lib.genList (count: lib.concatStringsSep "/" (lib.take (count + 1) parts)) (builtins.length parts - 1);
  selected = lib.genAttrs ([
    "THIRD_PARTY_NOTICES.md" "apps/web/LICENSE"
    "apps/web/package.json" "apps/web/package-lock.json" "apps/web/tsconfig.json"
    "apps/web/scripts/build-worker-client.mts"
  ] ++ imported) (_: true);
  directories = lib.genAttrs (lib.concatMap ancestors (builtins.attrNames selected)) (_: true);
  source = builtins.path {
    path = original;
    name = "reverie-worker-client-source";
    filter = path: type:
      let rel = lib.removePrefix ((toString original) + "/") (toString path); in
      if type == "directory" then directories ? ${rel} else selected ? ${rel};
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
