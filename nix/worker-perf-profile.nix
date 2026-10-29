{ pkgs, src, baseProfile }:
pkgs.runCommand "reverie-worker-task-perf-policy" {
  nativeBuildInputs = [ pkgs.python3 ];
} ''
  mkdir -p "$out/share/reverie"
  python3 ${src}/nix/worker-perf-profile.py \
    ${src}/python/reverie/worker_perf.py ${baseProfile} \
    "$out/share/reverie" ${pkgs.stdenv.hostPlatform.system}
''
