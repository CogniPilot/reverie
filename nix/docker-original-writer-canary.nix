# Build-only native acceptance bundle, with the same locked dependencies as the console.
# Production console checks are unchanged; this artifact is never installed in the image.
{ pkgs, console }:
pkgs.buildNpmPackage {
  pname = "reverie-original-writer-canary";
  inherit (console) version src npmDeps;
  nodejs = pkgs.nodejs_22;
  npmFlags = [ "--ignore-scripts" ];
  npmRebuildFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [ pkgs.esbuild ];
  dontNpmBuild = true;
  doCheck = true;
  buildPhase = ''
    runHook preBuild
    esbuild test/fixtures/docker-original-writer-native.ts \
      --bundle --platform=node --format=esm --target=node22 \
      --metafile=original-writer.meta.json --outfile=original-writer.mjs
    runHook postBuild
  '';
  checkPhase = ''
    runHook preCheck
    node --check original-writer.mjs
    node --input-type=module <<'JS'
    import fs from 'node:fs';
    import assert from 'node:assert/strict';
    const graph = JSON.parse(fs.readFileSync('original-writer.meta.json', 'utf8'));
    const paths = Object.keys(graph.inputs);
    assert.ok(paths.some(path => path.endsWith('src/docker-resource-original-writer.ts')));
    assert.ok(paths.some(path => path.endsWith('test/fixtures/docker-original-writer-native.ts')));
    assert.ok(!paths.some(path => /(?:docker-resource-revisions|docker-employee-store|docker-employee-runtime)\.ts$/.test(path)),
      'Read-only acceptance must not include the effect owners');
    JS
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out"
    cp original-writer.mjs original-writer.meta.json "$out/"
    runHook postInstall
  '';
}
