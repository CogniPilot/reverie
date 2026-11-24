# Owner-local metadata tooling; never a driver/service/permission installer.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [
      "reverie-gpu-preflight" "reverie-application" "reverie-host" "reverie-worker-client"
      "reverie-core" "reverie-contracts" "reverie-store" "reverie-http"
      "reverie-diagnostics" "reverie-python-regex"
    ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
  baseProfile = import ./worker-docker-profile.nix { inherit pkgs src; };
  policyV1 = import ./worker-perf-profile.nix { inherit pkgs src baseProfile; };
  policyV2 = import ./worker-perf-profile.nix { inherit pkgs src baseProfile; policy = "task-v2"; };
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-gpu-preflight";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-gpu-preflight" ];
  cargoTestFlags = [ "-p" "reverie-gpu-preflight" ];
  env = {
    REVERIE_FIXED_GPU_PREFLIGHT_ENGINE = "${pkgs.docker-client}/bin/docker";
    REVERIE_FIXED_TASK_PERF_MANIFEST = "${policyV1}/share/reverie/worker-perf-profile.json";
    REVERIE_FIXED_TASK_PERF_V2_MANIFEST = "${policyV2}/share/reverie/worker-perf-profile.json";
  };
  doCheck = true;
  meta = {
    description = "Read-only selected employee GPU/CDI/image preflight";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-worker-gpu";
  };
}
