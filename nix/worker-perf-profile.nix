{ pkgs, src, baseProfile, policy ? "task-v1" }:
assert builtins.elem policy [ "task-v1" "task-v2" ];
let
  producer = import ./policy-artifacts.nix { inherit pkgs src; };
in pkgs.runCommand (if policy == "task-v1" then "reverie-worker-task-perf-policy" else "reverie-worker-task-perf-policy-v2") {
  nativeBuildInputs = [ producer ];
} ''
  mkdir -p "$out/share/reverie"
  reverie-policy-artifacts --base-profile ${baseProfile} \
    --output-directory "$out/share/reverie" --system ${pkgs.stdenv.hostPlatform.system}${pkgs.lib.optionalString (policy != "task-v1") " --task-perf-policy ${policy}"}
''
