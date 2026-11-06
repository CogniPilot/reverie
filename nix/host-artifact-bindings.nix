# Compile-time facts for the eventual native broker, never instance config.
# Keep the existing producer's filtered identity until its separate required port.
{ pkgs, src }:
let
  baseProfile = import ./worker-docker-profile.nix { inherit pkgs; };
  taskPerfPolicy = import ./worker-perf-profile.nix {
    inherit pkgs src baseProfile;
  };
in {
  REVERIE_FIXED_TASK_PERF_MANIFEST =
    "${taskPerfPolicy}/share/reverie/worker-perf-profile.json";
}
