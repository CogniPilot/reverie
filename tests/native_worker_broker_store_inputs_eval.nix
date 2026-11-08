{ pkgs, src }:
let
  # A realized store file keeps this identity check independent of builds.
  fixture = builtins.toFile "reverie-native-broker-store-input" "fixture";
  # toPath returns a string; import a path literal to reproduce caller syntax.
  pathInput = import (builtins.toFile "reverie-native-broker-literal-input.nix" fixture);
  broker = import ../nix/native-worker-broker.nix {
    inherit pkgs src;
    previousUnit = pathInput;
    perfGuestCapsule = pathInput;
    taskPerfPolicy = pathInput;
    taskPerfPolicyV2 = pathInput;
  };
  checks = {
    previousUnitIdentity = builtins.elem
      "export REVERIE_FIXED_PREVIOUS_WORKER_SERVICE_UNIT=${fixture}/share/systemd/user/reverie-worker-broker.service"
      (pkgs.lib.splitString "\n" broker.preBuild);
    perfCapsuleIdentity = broker.REVERIE_FIXED_PERF_GUEST_CAPSULE_MANIFEST
      == "${fixture}/opt/reverie/perf/build-inputs.json";
    perfPolicyIdentity = broker.REVERIE_FIXED_TASK_PERF_MANIFEST
      == "${fixture}/share/reverie/worker-perf-profile.json";
    perfPolicyV2Identity = broker.REVERIE_FIXED_TASK_PERF_V2_MANIFEST
      == "${fixture}/share/reverie/worker-perf-profile.json";
  };
in
assert pkgs.lib.assertMsg (builtins.all (value: value) (builtins.attrValues checks))
  "Native broker package inputs must preserve their exact existing store identities";
checks
