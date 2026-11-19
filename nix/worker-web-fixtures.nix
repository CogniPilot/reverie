{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [
      "reverie-application" "reverie-host" "reverie-worker-client" "reverie-core"
      "reverie-contracts" "reverie-store" "reverie-http" "reverie-deployment"
      "reverie-diagnostics" "reverie-python-regex"
    ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-worker-web-fixtures";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  nativeBuildInputs = [ pkgs.jq pkgs.makeWrapper ];
  CARGO_PROFILE_TEST_DEBUG = "0";
  doCheck = false;
  buildPhase = ''
    runHook preBuild
    cargo test -p reverie-application -p reverie-host --lib --no-run --offline -j "$NIX_BUILD_CORES" --message-format=json > test-artifacts.jsonl
    jq -er 'select(.reason == "compiler-artifact" and .target.name == "reverie_application" and .profile.test) | .executable' test-artifacts.jsonl > fixture-path
    jq -er 'select(.reason == "compiler-artifact" and .target.name == "reverie_host" and .profile.test) | .executable' test-artifacts.jsonl > viewer-path
    rustc --edition=2024 crates/reverie-host/tests/support/engine_metadata_child.rs -o storage-writer
    rustc --edition=2024 crates/reverie-host/tests/support/worker_laptop_child.rs -o viewer-engine
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/libexec" "$out/bin"
    install -m755 "$(cat fixture-path)" "$out/libexec/goal-custody-test"
    install -m755 storage-writer "$out/libexec/storage-writer"
    makeWrapper "$out/libexec/goal-custody-test" "$out/bin/reverie-goal-custody-fixture" --set REVERIE_GOAL_FIXTURE_ENGINE "$out/libexec/storage-writer"
    install -m755 "$(cat viewer-path)" "$out/libexec/viewer-test"
    install -m755 viewer-engine "$out/libexec/viewer-engine"
    makeWrapper "$out/libexec/viewer-test" "$out/bin/reverie-viewer-fixture" --set FIXTURE_VIEWER_ENGINE "$out/libexec/viewer-engine"
    runHook postInstall
  '';
}
