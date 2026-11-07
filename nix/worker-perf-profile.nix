{ pkgs, src, baseProfile }:
let
  producer = import ./policy-artifacts.nix { inherit pkgs src; };
in pkgs.runCommand "reverie-worker-task-perf-policy" {
  nativeBuildInputs = [ producer ];
} ''
  mkdir -p "$out/share/reverie"
  reverie-policy-artifacts --base-profile ${baseProfile} \
    --output-directory "$out/share/reverie" --system ${pkgs.stdenv.hostPlatform.system}
''
