# Optional fixed job producer only. No broker installation, GPU device grant,
# credential, policy, service or capacity is created by this package.
{ pkgs, src }:
pkgs.buildNpmPackage {
  pname = "reverie-browser-job-runtime";
  version = "1";
  src = pkgs.lib.cleanSource (src + "/apps/web");
  nodejs = pkgs.nodejs_22;
  npmDepsHash = "sha256-DGKWvITtXvL3pYAsu4vqiynelRLeTR8BkjXJmLqMNc0=";
  npmFlags = [ "--ignore-scripts" ];
  npmRebuildFlags = [ "--ignore-scripts" ];
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  PUPPETEER_SKIP_DOWNLOAD = "1";
  dontNpmBuild = true;
  dontNpmPrune = true;
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node --test ${src}/scripts/browser-jobs/slam-driver.test.mjs ${src}/scripts/browser-jobs/slam-job-run.test.mjs
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/reverie-browser-job/node_modules"
    cp -r node_modules/playwright node_modules/playwright-core "$out/lib/reverie-browser-job/node_modules/"
    cp ${src}/scripts/browser-jobs/slam-driver.mjs ${src}/scripts/browser-jobs/slam-job-run.mjs "$out/lib/reverie-browser-job/"
    runHook postInstall
  '';
  meta.platforms = pkgs.lib.platforms.linux;
}
