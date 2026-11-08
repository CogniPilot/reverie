# Unselected native broker integration package. Its fixed build-only role emits
# provenance after stripping/fixup, hashing the actual final installed ELF.
{ pkgs, src, perfGuestCapsule ? null, taskPerfPolicy ? null, taskPerfPolicyV2 ? null, previousUnit ? null }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [
      "reverie-worker-broker" "reverie-application" "reverie-host"
      "reverie-core" "reverie-contracts" "reverie-store" "reverie-http"
      "reverie-diagnostics" "reverie-python-regex"
    ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-native-worker-broker";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-worker-broker" ];
  cargoTestFlags = [ "-p" "reverie-worker-broker" ];
  env = pkgs.lib.optionalAttrs (perfGuestCapsule != null) {
    REVERIE_FIXED_PERF_GUEST_CAPSULE_MANIFEST = "${perfGuestCapsule}/opt/reverie/perf/build-inputs.json";
  } // pkgs.lib.optionalAttrs (taskPerfPolicy != null) {
    REVERIE_FIXED_TASK_PERF_MANIFEST = "${taskPerfPolicy}/share/reverie/worker-perf-profile.json";
  } // pkgs.lib.optionalAttrs (taskPerfPolicyV2 != null) {
    REVERIE_FIXED_TASK_PERF_V2_MANIFEST = "${taskPerfPolicyV2}/share/reverie/worker-perf-profile.json";
  };
  preBuild = ''
    export REVERIE_FIXED_NATIVE_WORKER_SYSTEMCTL=${pkgs.systemdMinimal}/bin/systemctl
    export REVERIE_FIXED_NATIVE_WORKER_BUSCTL=${pkgs.systemdMinimal}/bin/busctl
    export REVERIE_FIXED_NATIVE_WORKER_NIX_STORE=${pkgs.nix}/bin/nix-store
    export REVERIE_FIXED_NATIVE_WORKER_SERVICE_UNIT="$out/share/systemd/user/reverie-worker-broker.service"
    ${pkgs.lib.optionalString (previousUnit != null) "export REVERIE_FIXED_PREVIOUS_WORKER_SERVICE_UNIT=${previousUnit}/share/systemd/user/reverie-worker-broker.service"}
    export REVERIE_FIXED_NATIVE_WORKER_ENGINE=${pkgs.docker-client}/bin/docker
    export REVERIE_FIXED_NATIVE_WORKER_BROKER_EXECUTABLE="$out/bin/reverie-worker-broker"
    export REVERIE_FIXED_NATIVE_WORKER_BROKER_MANIFEST="$out/share/reverie/worker-broker-program.json"
  '';
  postFixup = ''
    mkdir -p "$out/share/reverie"
    "$out/bin/reverie-worker-broker" origin-manifest
    mkdir -p "$out/share/systemd/user"
    "$out/bin/reverie-worker-broker" service-unit
  '';
  doCheck = true;
  meta = {
    description = "Unselected native worker broker and fixed original-process manifest";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-worker-broker";
  };
}
