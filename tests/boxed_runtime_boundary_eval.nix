# Pure mutations: no builds, engine, services or private data.
let
  expected = builtins.fromJSON (builtins.readFile ../nix/boxed-runtime-exports.json);
  verify = actual: source: import ../nix/boxed-runtime-boundary.nix { inherit actual source; };
  passes = actual: source: (builtins.tryEval ((verify actual source).passed)).success;
  without = group: name: expected // { ${group} = builtins.filter (v: v != name) expected.${group}; };
  add = group: name: expected // { ${group} = expected.${group} ++ [ name ]; };
  makeHelper = options: import ../nix/docker-resource-helper-image.nix ({
    pkgs = {
      lib.optionalAttrs = condition: value: if condition then value else {};
      writeText = _: bytes: "/fake/${(builtins.fromJSON bytes).name}";
      dockerTools.buildLayeredImage = value: value;
    };
    helper = "/fake/helper";
  } // options);
  gpu = import ../nix/container-gpu-image.nix {
    pkgs = {
      nodejs_22 = "/nix/store/controlled-node";
      tailscale.overrideAttrs = _: "/nix/store/controlled-tailscale";
      writeText = _: _: "/nix/store/controlled-model-relay";
      dockerTools.buildLayeredImage = value: value;
    };
    src = ../.;
    baseImage = "/nix/store/controlled-base";
    baseConfig = { Entrypoint = [ "/bin/tini" ]; Env = [ "KEPT=yes" ]; };
    containerRuntime = "/nix/store/controlled-runtime";
    entrypoint = "/nix/store/controlled-entry";
    inferenceRuntime = "/nix/store/controlled-inference";
  };
  checks = {
    actualSurfaceAccepted = passes expected ../.;
    exactRetiredUnitNamesPreserved = (verify expected ../.).retiredUnits == [
      "reverie.service"
      "reverie-engine.service"
      "reverie-host.service"
      "reverie-gpu-publisher.service"
      "reverie-worker-broker.service"
      "reverie-local-model.service"
      "reverie-worker-viewer.service"
      "reverie-ops.service"
    ];
    exactRetiredFactoryNamesPreserved = (verify expected ../.).retiredFactories == [
      "nix/local-model.nix"
      "nix/ops-core.nix"
      "nix/owner-terminal-packages.nix"
      "python/reverie/ops_installer.py"
    ];
    brokerCannotReturn = !(passes (add "packages" "workerBroker") ../.);
    renamedHostAliasCannotSneakIn = !(passes (add "packages" "newHostDaemon") ../.);
    opsExecutorCannotReturn = !(passes (add "packages" "opsCore") ../.);
    opsServiceCannotReturn = !(passes (add "apps" "ops-service") ../.);
    serviceAppCannotReturn = !(passes (add "apps" "worker-service") ../.);
    viewerCannotReturn = !(passes (add "packages" "nativeWorkerViewerImage") ../.);
    modelCannotReturn = !(passes (add "packages" "localModel") ../.);
    gpuCannotReturn = !(passes (add "packages" "gpuPublisher") ../.);
    moduleCannotReturn = !(passes (add "nixosModules" "workerIsolation") ../.);
    serviceUnitCannotReturn = !(passes expected ./fixtures/retired_host_unit);
    dockerCannotDisappear = !(passes (without "packages" "dockerImage") ../.);
    gpuFactoryCannotDisappear = !(passes (without "lib" "mkContainerGpuImage") ../.);
    boxedClientCapsuleCannotDisappear = !(passes (without "packages" "workerClientCapsule") ../.);
    poolRestoreImageCannotDisappear = !(passes (without "packages" "docker-pool-restore-helper-image") ../.);
    recoveryImageCannotDisappear = !(passes (without "packages" "docker-recovery-helper-image") ../.);
    poolRestoreDoesNotChangeOriginalHelper = let
      baseline = makeHelper {};
      restore = makeHelper { poolRestore = true; };
    in baseline.config.Labels == { "org.reverie.purpose" = "boxed-resource-helper-v1"; }
      && restore.config.Labels == (baseline.config.Labels // { "org.reverie.resource.pool-restore" = "v1"; })
      && removeAttrs restore.config [ "Labels" ] == removeAttrs baseline.config [ "Labels" ];
    recoveryImageIdentityDoesNotChangeHelperConfiguration = let
      baseline = makeHelper {};
      recovery = makeHelper { name = "reverie-boxed-recovery-helper"; };
    in recovery.config == baseline.config && recovery.contents == baseline.contents
      && builtins.match ".*cp /fake/reverie-boxed-recovery-helper share/reverie/helper-image-identity.json.*"
        recovery.extraCommands != null
      && baseline.extraCommands != recovery.extraCommands;
    gpuKeepsContainerSupervisor = gpu.config.Entrypoint == [
      "/bin/tini" "-g" "-s" "--" "/nix/store/controlled-runtime/bin/reverie-container-runtime"
      "/usr/local/bin/reverie-start"
    ];
    gpuUsesNativeBootstrap = builtins.match
      ".*ln -s /nix/store/controlled-entry usr/local/bin/reverie-start.*" gpu.extraCommands != null;
    gpuKeepsPrivateTelemetry = builtins.elem "/nix/store/controlled-runtime" gpu.contents
      && builtins.elem "REVERIE_GPU_PUBLISHER=/nix/store/controlled-runtime/bin/reverie-gpu-publisher" gpu.config.Env;
    gpuKeepsPrivateAccess = builtins.elem "/nix/store/controlled-tailscale" gpu.contents;
    gpuKeepsModelRelay = builtins.elem "REVERIE_MODEL_RELAY_SCRIPT=/nix/store/controlled-model-relay" gpu.config.Env;
    gpuKeepsInferenceAndBase = gpu.fromImage == "/nix/store/controlled-base"
      && builtins.elem "/nix/store/controlled-inference" gpu.contents
      && builtins.elem "KEPT=yes" gpu.config.Env;
    gpuExportsItsActualConfig = gpu.passthru.reverieConfig == gpu.config;
    gpuLeavesRoomForBoxedWebsite = gpu.maxLayers + 2 <= 125;
  };
in assert builtins.all (value: value) (builtins.attrValues checks); checks
