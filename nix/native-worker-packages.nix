# Native broker packages with an explicit immutable website console input.
# Regenerate complete program/profile provenance; never copy a prior manifest.
# An already-qualified console remains subject to the complete console/Node
# measurements in workerResumeProgram's normal build.
{ pkgs, src, console, ownerTerminalProgram ? null }:
rec {
  workerDockerSeccomp = import ./worker-docker-profile.nix { inherit pkgs; };
  workerTaskPerfPolicy = import ./worker-perf-profile.nix {
    inherit pkgs src;
    baseProfile = workerDockerSeccomp;
  };
  workerResumeProgram = import ./worker-resume-program.nix {
    inherit pkgs src console ownerTerminalProgram;
  };
  workerBrokerSource = pkgs.runCommand "reverie-worker-broker-source" {
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
  workerBroker = pkgs.writeShellApplication {
    name = "reverie-worker-broker";
    # Fixed GPU CDI YAML parser; retain the protected isolated entry.
    runtimeInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) pkgs.docker-client ];
    text = ''exec ${pkgs.python3.withPackages (ps: [ ps.pyyaml ])}/bin/python3 -I -B ${workerBrokerSource}/python/reverie/worker.py broker "$@"'';
  };
  workerServiceCheck = pkgs.writeShellApplication {
    name = "reverie-worker-service-check";
    runtimeInputs = [ pkgs.python3 pkgs.docker-client ];
    text = ''
      export PYTHONPATH=${src}/python
      exec python3 -m reverie.worker_service "$@" check-backend
    '';
  };
  workerService = pkgs.writeTextDir "share/systemd/user/reverie-worker-broker.service" ''
    [Unit]
    Description=Reverie laptop broker and office watchdog
    [Service]
    EnvironmentFile=%h/.config/reverie/worker-broker.env
    ExecStartPre=${workerServiceCheck}/bin/reverie-worker-service-check --config ''${REVERIE_WORKER_CONFIG}
    ExecStart=${workerBroker}/bin/reverie-worker-broker --config ''${REVERIE_WORKER_CONFIG}
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
  workerServiceSetup = pkgs.writeShellApplication {
    name = "reverie-worker-service";
    runtimeInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) pkgs.docker-client pkgs.systemd pkgs.nix ];
    text = ''
      export REVERIE_WORKER_SERVICE_UNIT=${workerService}/share/systemd/user/reverie-worker-broker.service
      export REVERIE_WORKER_SERVICE_PYTHON=${pkgs.python3}/bin/python3
      export REVERIE_WORKER_SERVICE_ENTRY=${workerBrokerSource}/python/reverie/worker.py
      exec python3 -I -B ${src}/python/reverie/worker_service.py "$@"
    '';
  };
  workerResumeClient = pkgs.writeShellApplication {
    name = "reverie-worker-resume";
    runtimeInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) pkgs.systemd ];
    text = ''
      export REVERIE_WORKER_SERVICE_UNIT=${workerService}/share/systemd/user/reverie-worker-broker.service
      export REVERIE_WORKER_SERVICE_PYTHON=${pkgs.python3}/bin/python3
      export REVERIE_WORKER_SERVICE_ENTRY=${workerBrokerSource}/python/reverie/worker.py
      exec python3 -I -B ${workerBrokerSource}/python/reverie/worker_resume_client.py "$@"
    '';
  };
  workerTaskPerfClient = pkgs.writeShellApplication {
    name = "reverie-worker-task-perf";
    runtimeInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) pkgs.systemd ];
    text = ''
      export REVERIE_WORKER_SERVICE_UNIT=${workerService}/share/systemd/user/reverie-worker-broker.service
      export REVERIE_WORKER_SERVICE_PYTHON=${pkgs.python3}/bin/python3
      export REVERIE_WORKER_SERVICE_ENTRY=${workerBrokerSource}/python/reverie/worker.py
      exec python3 -I -B ${workerBrokerSource}/python/reverie/worker_perf_client.py "$@"
    '';
  };
}
