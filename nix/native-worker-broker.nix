# Unselected native broker integration package. Its fixed build-only role emits
# provenance after stripping/fixup, hashing the actual final installed ELF.
{ pkgs, src, perfGuestCapsule ? null, taskPerfPolicy ? null, taskPerfPolicyV2 ? null }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-native-worker-broker";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
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
    export REVERIE_FIXED_NATIVE_WORKER_ENGINE=${pkgs.docker-client}/bin/docker
    export REVERIE_FIXED_NATIVE_WORKER_BROKER_EXECUTABLE="$out/bin/reverie-worker-broker"
    export REVERIE_FIXED_NATIVE_WORKER_BROKER_MANIFEST="$out/share/reverie/worker-broker-program.json"
  '';
  postFixup = ''
    mkdir -p "$out/share/reverie"
    "$out/bin/reverie-worker-broker" origin-manifest
  '';
  doCheck = true;
  meta = {
    description = "Unselected native worker broker and fixed original-process manifest";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-worker-broker";
  };
}
