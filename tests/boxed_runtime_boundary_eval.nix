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
    gpuKeepsContainerSupervisor = gpu.config.Entrypoint == [
      "/bin/tini" "-g" "-s" "--" "/nix/store/controlled-runtime/bin/reverie-container-runtime"
      "/usr/local/bin/reverie-start"
    ];
    gpuKeepsPrivateTelemetry = builtins.elem "/nix/store/controlled-telemetry" gpu.contents
      && builtins.elem "REVERIE_GPU_PUBLISHER=/nix/store/controlled-telemetry/bin/reverie-container-gpu-telemetry" gpu.config.Env;
    gpuKeepsInferenceAndBase = gpu.fromImage == "/nix/store/controlled-base"
      && builtins.elem "/nix/store/controlled-inference" gpu.contents
      && builtins.elem "KEPT=yes" gpu.config.Env;
  };
in assert builtins.all (value: value) (builtins.attrValues checks); checks
