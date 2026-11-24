# Unselected native broker integration package. Its fixed build-only role emits
# provenance after stripping/fixup, hashing the actual final installed ELF.
{ pkgs, src, perfGuestCapsule ? null, taskPerfPolicy ? null, taskPerfPolicyV2 ? null, previousUnit ? null, poolImageInputs ? null, previousPoolImageInputs ? null, resourceActorProvenance ? null }:
let
  # Interpolating a path copies it, even when it already names a store object.
  # Keep the original identity and its closure reference for fixed artifacts.
  exactInput = input: if builtins.isPath input then
    builtins.appendContext (toString input) {
      "${toString input}" = { path = true; };
    }
    else input;
  capsule = exactInput perfGuestCapsule;
  perfPolicy = exactInput taskPerfPolicy;
  perfPolicyV2 = exactInput taskPerfPolicyV2;
  predecessor = exactInput previousUnit;
  poolInputs = exactInput poolImageInputs;
  previousPoolInputs = exactInput previousPoolImageInputs;
  actorProvenance = exactInput resourceActorProvenance;
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [
      "reverie-worker-broker" "reverie-application" "reverie-host" "reverie-worker-client"
      "reverie-core" "reverie-contracts" "reverie-store" "reverie-http" "reverie-deployment"
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
  # The embedded deployment library uses these same fixed snapshot tools.
  REVERIE_DEPLOYMENT_TAR = "${pkgs.gnutar}/bin/tar";
  REVERIE_DEPLOYMENT_GETFATTR = "${pkgs.attr}/bin/getfattr";
  REVERIE_DEPLOYMENT_GETFACL = "${pkgs.acl}/bin/getfacl";
  REVERIE_DEPLOYMENT_COPY = "${pkgs.coreutils}/bin/cp";
  env = pkgs.lib.optionalAttrs (perfGuestCapsule != null) {
    REVERIE_FIXED_PERF_GUEST_CAPSULE_MANIFEST = "${capsule}/opt/reverie/perf/build-inputs.json";
  } // pkgs.lib.optionalAttrs (taskPerfPolicy != null) {
    REVERIE_FIXED_TASK_PERF_MANIFEST = "${perfPolicy}/share/reverie/worker-perf-profile.json";
  } // pkgs.lib.optionalAttrs (taskPerfPolicyV2 != null) {
    REVERIE_FIXED_TASK_PERF_V2_MANIFEST = "${perfPolicyV2}/share/reverie/worker-perf-profile.json";
  };
  preBuild = ''
    ${pkgs.lib.optionalString (resourceActorProvenance != null) ''
      export REVERIE_FIXED_NATIVE_ACTOR_IMAGE_PROVENANCE_MANIFEST=${pkgs.lib.escapeShellArg "${actorProvenance}/share/reverie/website-image.json"}
      export REVERIE_FIXED_NATIVE_ACTOR_IMAGE_PROVENANCE_SHA256="$(${pkgs.coreutils}/bin/sha256sum "$REVERIE_FIXED_NATIVE_ACTOR_IMAGE_PROVENANCE_MANIFEST" | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
    ''}
    ${pkgs.lib.optionalString (poolImageInputs != null) ''
      export REVERIE_FIXED_NATIVE_POOL_IMAGE_INPUTS_MANIFEST=${pkgs.lib.escapeShellArg "${poolInputs}/share/reverie/worker-pool-image-inputs.json"}
      export REVERIE_FIXED_NATIVE_POOL_IMAGE_INPUTS_SHA256="$(${pkgs.coreutils}/bin/sha256sum "$REVERIE_FIXED_NATIVE_POOL_IMAGE_INPUTS_MANIFEST" | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
    ''}
    ${pkgs.lib.optionalString (previousPoolImageInputs != null) ''
      export REVERIE_FIXED_PREVIOUS_WORKER_POOL_IMAGE_INPUTS_MANIFEST=${pkgs.lib.escapeShellArg "${previousPoolInputs}/share/reverie/worker-pool-image-inputs.json"}
      export REVERIE_FIXED_PREVIOUS_WORKER_POOL_IMAGE_INPUTS_SHA256="$(${pkgs.coreutils}/bin/sha256sum "$REVERIE_FIXED_PREVIOUS_WORKER_POOL_IMAGE_INPUTS_MANIFEST" | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
    ''}
    export REVERIE_FIXED_NATIVE_WORKER_SYSTEMCTL=${pkgs.systemdMinimal}/bin/systemctl
    export REVERIE_FIXED_NATIVE_WORKER_BUSCTL=${pkgs.systemdMinimal}/bin/busctl
    export REVERIE_FIXED_NATIVE_WORKER_NIX_STORE=${pkgs.nix}/bin/nix-store
    export REVERIE_FIXED_NATIVE_WORKER_SERVICE_UNIT="$out/share/systemd/user/reverie-worker-broker.service"
    export REVERIE_FIXED_NATIVE_POOL_OFFER_SERVICE_UNIT="$out/share/systemd/pool-offer/reverie-worker-broker.service"
    ${pkgs.lib.optionalString (previousUnit != null) "export REVERIE_FIXED_PREVIOUS_WORKER_SERVICE_UNIT=${predecessor}/share/systemd/user/reverie-worker-broker.service"}
    export REVERIE_FIXED_NATIVE_WORKER_ENGINE=${pkgs.docker-client}/bin/docker
    export REVERIE_FIXED_NATIVE_WORKER_BROKER_EXECUTABLE="$out/bin/reverie-worker-broker"
    export REVERIE_FIXED_NATIVE_WORKER_BROKER_MANIFEST="$out/share/reverie/worker-broker-program.json"
  '';
  postFixup = ''
    mkdir -p "$out/share/reverie"
    "$out/bin/reverie-worker-broker" origin-manifest
    mkdir -p "$out/share/systemd/user"
    mkdir -p "$out/share/systemd/pool-offer"
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
