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
  pname = "reverie-goal-custody-fixture";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  nativeBuildInputs = [ pkgs.jq pkgs.makeWrapper ];
  CARGO_PROFILE_TEST_DEBUG = "0";
  doCheck = false;
  buildPhase = ''
    runHook preBuild
    cargo test -p reverie-application --lib --no-run --offline -j "$NIX_BUILD_CORES" --message-format=json > test-artifacts.jsonl
    jq -er 'select(.reason == "compiler-artifact" and .target.name == "reverie_application" and .profile.test) | .executable' test-artifacts.jsonl > fixture-path
    rustc --edition=2024 crates/reverie-host/tests/support/engine_metadata_child.rs -o storage-writer
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/libexec" "$out/bin"
    install -m755 "$(cat fixture-path)" "$out/libexec/goal-custody-test"
    install -m755 storage-writer "$out/libexec/storage-writer"
    makeWrapper "$out/libexec/goal-custody-test" "$out/bin/reverie-goal-custody-fixture" --set REVERIE_GOAL_FIXTURE_ENGINE "$out/libexec/storage-writer"
    runHook postInstall
  '';
}
