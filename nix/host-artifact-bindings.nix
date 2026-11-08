# Compile-time facts for the eventual native broker, never instance config.
# The Rust producer projects only its actual crate/dependency inputs.
{ pkgs, src }:
let
  baseProfile = import ./worker-docker-profile.nix { inherit pkgs src; };
  taskPerfPolicy = import ./worker-perf-profile.nix {
    inherit pkgs src baseProfile;
  };
  taskPerfPolicyV2 = import ./worker-perf-profile.nix {
    inherit pkgs src baseProfile;
    policy = "task-v2";
  };
in {
  REVERIE_FIXED_TASK_PERF_MANIFEST =
    "${taskPerfPolicy}/share/reverie/worker-perf-profile.json";
  REVERIE_FIXED_TASK_PERF_V2_MANIFEST =
    "${taskPerfPolicyV2}/share/reverie/worker-perf-profile.json";
}
