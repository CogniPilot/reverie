# Native broker packages with an explicit immutable website console input.
# Regenerate complete program/profile provenance; never copy a prior manifest.
# An already-qualified console remains subject to the complete console/Node
# measurements in workerResumeProgram's normal build.
{ pkgs, src, console, ownerTerminalProgram ? null }:
rec {
  # Independent terminal transport. Its optional broker integrations are absent:
  # this package only attaches to existing employee laptops.
  nativeWorkerViewerProgram = import ./native-worker-broker.nix {
    inherit pkgs src;
  };
  nativeWorkerViewerImage = import ./worker-viewer-image.nix {
    inherit pkgs;
    broker = nativeWorkerViewerProgram;
  };
  nativeWorkerPoolAnchorImage = import ./worker-pool-anchor-image.nix { inherit pkgs; };
  nativeWorkerResourceController = import ./worker-resource-controller.nix { inherit pkgs src; };
  nativeWorkerResourceControllerImage = import ./worker-resource-controller-image.nix {
    inherit pkgs;
    controller = nativeWorkerResourceController;
  };
  nativeWorkerPoolImageInputs = import ./worker-pool-image-inputs.nix {
    inherit pkgs src;
    controllerImage = nativeWorkerResourceControllerImage;
    controllerProgram = nativeWorkerResourceController;
    anchorImage = nativeWorkerPoolAnchorImage;
  };
  # Explicit integration output only; the shipped hybrid workerBroker below is
  # unchanged until mandatory native service/maintenance consumers qualify.
  nativeWorkerBroker = import ./native-worker-broker.nix {
    inherit pkgs src;
    previousUnit = legacyWorkerService;
    perfGuestCapsule = nativePerfGuestCapsule;
    taskPerfPolicy = workerTaskPerfPolicy;
    taskPerfPolicyV2 = workerTaskPerfPolicyV2;
    poolImageInputs = nativeWorkerPoolImageInputs;
  };
  nativePerfGuestCapsule = import ./perf-guest-capsule.nix { inherit pkgs src; };
  workerDockerSeccomp = import ./worker-docker-profile.nix { inherit pkgs src; };
  workerTaskPerfPolicy = import ./worker-perf-profile.nix {
    inherit pkgs src;
    baseProfile = workerDockerSeccomp;
  };
  workerTaskPerfPolicyV2 = import ./worker-perf-profile.nix {
    inherit pkgs src;
    baseProfile = workerDockerSeccomp;
    policy = "task-v2";
  };
  workerResumeProgram = import ./worker-resume-program.nix {
    inherit pkgs src console ownerTerminalProgram;
  };
  legacyWorkerBrokerSource = pkgs.runCommand "reverie-worker-broker-source" {
    nativeBuildInputs = [ pkgs.python3 ];
  } ''
    mkdir -p "$out"
    cp -R ${src}/python "$out/python"
    chmod u+w "$out/python/reverie"
    cp ${workerResumeProgram}/share/reverie/worker-resume-program.json \
      "$out/python/reverie/worker-resume-program.json"
    cp ${workerTaskPerfPolicy}/share/reverie/worker-perf-profile.json \
      "$out/python/reverie/worker-perf-profile.json"
    python3 - "$out/python" <<'PY'
    import pathlib,sys
    root=pathlib.Path(sys.argv[1]);files=[p for p in root.rglob('*') if p.is_file()]
    assert not any(p.is_symlink() for p in root.rglob('*'))
    assert len(files)<=4096 and sum(p.stat().st_size for p in files)<=64*1024**2
    assert all(p.stat().st_size<=16*1024**2 for p in files)
    PY
  '';
  legacyWorkerBroker = pkgs.writeShellApplication {
    name = "reverie-worker-broker";
    # Fixed GPU CDI YAML parser; retain the protected isolated entry.
    runtimeInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) pkgs.docker-client ];
    text = ''exec ${pkgs.python3.withPackages (ps: [ ps.pyyaml ])}/bin/python3 -I -B ${legacyWorkerBrokerSource}/python/reverie/worker.py broker "$@"'';
  };
  # Root soft-limit helper: one connection per instance, immutable source, no broker configuration.
  softLimitHelper = import ./soft-limit-helper.nix { inherit pkgs src; };
  legacyWorkerServiceCheck = pkgs.writeShellApplication {
    name = "reverie-worker-service-check";
    runtimeInputs = [ pkgs.python3 pkgs.docker-client ];
    text = ''
      exec python3 -I -B ${legacyWorkerBrokerSource}/python/reverie/worker_service.py "$@" check-backend
    '';
  };
  legacyWorkerService = pkgs.writeTextDir "share/systemd/user/reverie-worker-broker.service" ''
    [Unit]
    Description=Reverie laptop broker and office watchdog
    [Service]
    EnvironmentFile=%h/.config/reverie/worker-broker.env
    ExecStartPre=${legacyWorkerServiceCheck}/bin/reverie-worker-service-check --config ''${REVERIE_WORKER_CONFIG}
    ExecStart=${legacyWorkerBroker}/bin/reverie-worker-broker --config ''${REVERIE_WORKER_CONFIG}
    Restart=on-failure
    RestartSec=3
    TimeoutStopSec=35
    KillMode=mixed
    UMask=0077
    NoNewPrivileges=true
    MemoryMax=512M
    TasksMax=512
    [Install]
    WantedBy=default.target
  '';
  # Compatibility selections stay unchanged. The native predecessor never
  # follows a future change to these public default aliases.
  workerBrokerSource = legacyWorkerBrokerSource;
  workerBroker = legacyWorkerBroker;
  workerServiceCheck = legacyWorkerServiceCheck;
  workerService = legacyWorkerService;
  workerServiceSetup = pkgs.writeShellApplication {
    name = "reverie-worker-service";
    runtimeInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) pkgs.docker-client pkgs.systemd pkgs.nix ];
    text = ''
      export REVERIE_WORKER_SERVICE_UNIT=${legacyWorkerService}/share/systemd/user/reverie-worker-broker.service
      export REVERIE_WORKER_SERVICE_PYTHON=${pkgs.python3}/bin/python3
      export REVERIE_WORKER_SERVICE_ENTRY=${legacyWorkerBrokerSource}/python/reverie/worker.py
      exec python3 -I -B ${legacyWorkerBrokerSource}/python/reverie/worker_service.py "$@"
    '';
  };
  workerResumeClient = pkgs.writeShellApplication {
    name = "reverie-worker-resume";
    runtimeInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) pkgs.systemd ];
    text = ''
      export REVERIE_WORKER_SERVICE_UNIT=${legacyWorkerService}/share/systemd/user/reverie-worker-broker.service
      export REVERIE_WORKER_SERVICE_PYTHON=${pkgs.python3}/bin/python3
      export REVERIE_WORKER_SERVICE_ENTRY=${legacyWorkerBrokerSource}/python/reverie/worker.py
      exec python3 -I -B ${legacyWorkerBrokerSource}/python/reverie/worker_resume_client.py "$@"
    '';
  };
  workerTaskPerfClient = pkgs.writeShellApplication {
    name = "reverie-worker-task-perf";
    runtimeInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) pkgs.systemd ];
    text = ''
      export REVERIE_WORKER_SERVICE_UNIT=${legacyWorkerService}/share/systemd/user/reverie-worker-broker.service
      export REVERIE_WORKER_SERVICE_PYTHON=${pkgs.python3}/bin/python3
      export REVERIE_WORKER_SERVICE_ENTRY=${legacyWorkerBrokerSource}/python/reverie/worker.py
      exec python3 -I -B ${legacyWorkerBrokerSource}/python/reverie/worker_perf_client.py "$@"
    '';
  };
}
