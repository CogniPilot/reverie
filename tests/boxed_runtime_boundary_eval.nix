# Pure mutations: no builds, engine, services or private data.
let
  expected = builtins.fromJSON (builtins.readFile ../nix/boxed-runtime-exports.json);
  verify = actual: source: import ../nix/boxed-runtime-boundary.nix { inherit actual source; };
  passes = actual: source: (builtins.tryEval ((verify actual source).passed)).success;
  without = group: name: expected // { ${group} = builtins.filter (v: v != name) expected.${group}; };
  add = group: name: expected // { ${group} = expected.${group} ++ [ name ]; };
  gpu = import ../nix/container-gpu-image.nix {
    pkgs = {
      writeShellScript = _: _: "/nix/store/controlled-entry";
      nodejs_22 = "/nix/store/controlled-node";
      dockerTools.buildLayeredImage = value: value;
    };
    src = ../.;
    baseImage = "/nix/store/controlled-base";
    baseConfig = { Entrypoint = [ "/bin/tini" ]; Env = [ "KEPT=yes" ]; };
    containerRuntime = "/nix/store/controlled-runtime";
    gpuTelemetry = "/nix/store/controlled-telemetry";
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
    poolRestoreDoesNotChangeOriginalHelper = let
      pkgs = { lib.optionalAttrs = condition: value: if condition then value else {}; writeText = _: _: "/fake/identity"; dockerTools.buildLayeredImage = value: value; };
      make = import ../nix/docker-resource-helper-image.nix;
      baseline = make { inherit pkgs; helper = "/fake/helper"; };
      restore = make { inherit pkgs; helper = "/fake/helper"; poolRestore = true; };
    in baseline.config.Labels == { "org.reverie.purpose" = "boxed-resource-helper-v1"; }
      && restore.config.Labels == (baseline.config.Labels // { "org.reverie.resource.pool-restore" = "v1"; })
      && removeAttrs restore.config [ "Labels" ] == removeAttrs baseline.config [ "Labels" ];
    gpuKeepsContainerSupervisor = gpu.config.Entrypoint == [
      "/bin/tini" "-g" "-s" "--" "/nix/store/controlled-runtime/bin/reverie-container-runtime"
      "/usr/local/bin/reverie-start"
    ];
    gpuKeepsPrivateTelemetry = builtins.elem "/nix/store/controlled-telemetry" gpu.contents
      && builtins.elem "REVERIE_GPU_PUBLISHER=/nix/store/controlled-telemetry/bin/reverie-container-gpu-telemetry" gpu.config.Env;
    gpuKeepsInferenceAndBase = gpu.fromImage == "/nix/store/controlled-base"
      && builtins.elem "/nix/store/controlled-inference" gpu.contents
      && builtins.elem "KEPT=yes" gpu.config.Env;
    gpuExportsItsActualConfig = gpu.passthru.reverieConfig == gpu.config;
    gpuLeavesRoomForBoxedWebsite = gpu.maxLayers + 2 <= 125;
  };
in assert builtins.all (value: value) (builtins.attrValues checks); checks
