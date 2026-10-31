{ pkgs, src, baseProfile }:
let
  # Unrelated release files must not change a running laptop's fixed profile.
  # Project each actual input to its own content-addressed immutable store path.
  producer = builtins.path {
    path = src + "/nix/worker-perf-profile.py";
    name = "worker-perf-profile.py";
  };
  policyModule = builtins.path {
    path = src + "/python/reverie/worker_perf.py";
    name = "worker_perf.py";
  };
in pkgs.runCommand "reverie-worker-task-perf-policy" {
  nativeBuildInputs = [ pkgs.python3 ];
} ''
  mkdir -p "$out/share/reverie"
  python3 ${producer} ${policyModule} ${baseProfile} \
    "$out/share/reverie" ${pkgs.stdenv.hostPlatform.system}
''
