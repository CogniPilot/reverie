# Finite public-surface retirement policy; not a proof about arbitrary program behavior.
{ actual, source, expected ? builtins.fromJSON (builtins.readFile ./boxed-runtime-exports.json) }:
let
  retired = {
    packages = [
      "workerBroker" "legacyWorkerBroker" "nativeWorkerBroker" "workerService" "legacyWorkerService"
      "workerServiceSetup" "workerServiceCheck" "workerResumeClient" "workerTaskPerfClient"
      "nativeWorkerViewerProgram" "nativeWorkerViewerImage" "localModel" "gpuPublisher" "isolate"
      "previewProxy" "previewService" "ownerTerminalHost" "ownerTerminalLifecycle"
      "ownerTerminalWebsiteSetup" "resourceTerminalHost" "resourceTerminalLifecycle"
      "resourceActorInstaller" "resourceActorRefresh" "resourceActorBootstrap"
      "resourceTerminalInstaller" "resourceTerminalRefresh" "opsCore"
    ];
    apps = [
      "ops-service" "worker-service" "worker-resume" "worker-task-perf" "worker-gpu" "local-model" "isolate"
      "preview-proxy" "owner-terminal-lifecycle" "owner-terminal-website" "resource-terminal-lifecycle"
      "resource-actor-enable" "resource-actor-install" "resource-actor-refresh"
      "resource-terminal-install" "resource-terminal-refresh"
    ];
    nixosModules = [ "workerIsolation" ];
    lib = [ "nativeWorkerPackages" "ownerTerminalPackages" ];
  };
  retiredUnits = [
    "reverie.service" "reverie-engine.service" "reverie-host.service" "reverie-gpu-publisher.service"
    "reverie-worker-broker.service" "reverie-local-model.service" "reverie-worker-viewer.service" "reverie-ops.service"
  ];
  groups = [ "packages" "apps" "nixosModules" "lib" ];
  sorted = values: builtins.sort builtins.lessThan values;
  checks = builtins.listToAttrs (map (group: {
    name = group;
    value = sorted actual.${group} == sorted expected.${group}
      && builtins.all (name: !(builtins.elem name actual.${group})) retired.${group};
  }) groups) // {
    retiredUnitsAbsent = builtins.all
      (name: !(builtins.pathExists (source + "/systemd/${name}"))) retiredUnits;
    dockerInputsRetained = builtins.all (name: builtins.elem name actual.packages)
      [ "dockerImage" "containerRuntime" "workerImage" "workerChild" "workerDocker" "workerGpuToolkit" ];
    containerGpuFactoryRetained = builtins.elem "mkContainerGpuImage" actual.lib;
  };
in if builtins.all (value: value) (builtins.attrValues checks) then { passed = true; inherit checks; }
else throw "Retired host launch export/unit returned, unreviewed public export changed, or Docker input disappeared"
