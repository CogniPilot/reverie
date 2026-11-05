# Pure NixOS evaluation of the soft-limit helper options, with synthetic paths and no host activation.
{ nixpkgs, brokerPackage, softLimitHelperPackage, system ? builtins.currentSystem }:
let
  lib = nixpkgs.lib;
  employee = "22222222-2222-4222-8222-222222222222";
  other = "33333333-3333-4333-8333-333333333333";
  # Only the kernel's version strings are read; no kernel is built.
  withKernel = version: { pkgs, ... }: {
    boot.kernelPackages = lib.mkForce (pkgs.linuxPackages // {
      kernel = pkgs.linuxPackages.kernel // { inherit version; modDirVersion = version; };
    });
  };
  workers = {
    enable = true;
    user = "agent";
    configFile = "/home/agent/.config/reverie/worker.json";
    stateRoot = "/srv/reverie/state";
    socketDirectory = "/run/reverie-worker";
    scratchRoot = "/srv/reverie/scratch";
    apiSocketRoot = "/run/reverie-api";
    poolMemoryMiB = 49152;
  };
  helper = {
    enable = true;
    brokerUid = 1000;
    brokerGroup = "agent";
    entries = [ { employeeId = employee; memoryMaxMiB = 4096; memoryHighMiB = 3072; } ];
  };
  evaluate = kernel: settings: (import "${nixpkgs}/nixos/lib/eval-config.nix" {
    inherit system;
    modules = [
      ({ config, lib, pkgs, ... }: import ../nix/worker-isolation.nix {
        inherit config lib pkgs brokerPackage softLimitHelperPackage;
      })
      (withKernel kernel)
      { system.stateVersion = "26.05"; services.reverieWorkers = settings; }
    ];
  }).config;
  # Only this module's assertions: a synthetic evaluation also fails unrelated NixOS base checks.
  failing = c: builtins.any (entry: !entry.assertion && lib.hasInfix "softlimithelper" (lib.toLower entry.message)) c.assertions;
  disabled = evaluate "6.18.39" workers;
  enabled = evaluate "6.18.39" (workers // { softLimitHelper = helper; });
  oldKernel = evaluate "6.12.0" (workers // { softLimitHelper = helper; });
  attested = evaluate "6.12.0" (workers // { softLimitHelper = helper // { backportAttested = "vendor 6.12.0-77 carries the O_NONBLOCK memory_high_write check"; }; });
  emptyAttestation = evaluate "6.12.0" (workers // { softLimitHelper = helper // { backportAttested = ""; }; });
  highAtMax = evaluate "6.18.39" (workers // { softLimitHelper = helper // { entries = [ { employeeId = employee; memoryMaxMiB = 4096; memoryHighMiB = 4096; } ]; }; });
  duplicate = evaluate "6.18.39" (workers // { softLimitHelper = helper // { entries = helper.entries ++ helper.entries; }; });
  socket = enabled.systemd.sockets.reverie-soft-limit.socketConfig;
  service = enabled.systemd.services."reverie-soft-limit@".serviceConfig;
  policy = builtins.fromJSON enabled.environment.etc."reverie/soft-limit-policy.json".text;
  checks = {
    disabledInstallsNothing = !(disabled.systemd.sockets ? reverie-soft-limit) && !(disabled.environment.etc ? "reverie/soft-limit-policy.json");
    enabledIsClean = !(failing enabled);
    socketBounds = socket.Accept == true && socket.MaxConnections == 4 && socket.Backlog == 4 && socket.SocketMode == "0660" &&
      socket.SocketUser == "root" && socket.SocketGroup == "agent" && socket.ListenStream == "/run/reverie-soft-limit/soft-limit.sock";
    serviceBounds = service.Type == "exec" && service.StandardInput == "socket" && service.KillMode == "control-group" &&
      service.RuntimeMaxSec == "10s" && service.TimeoutStartSec == "5s" && service.Restart == "no" && service.Slice == "reverie-soft-limit.slice";
    serviceHardening = service.CapabilityBoundingSet == "" && service.NoNewPrivileges && service.PrivateNetwork &&
      service.RestrictAddressFamilies == "AF_UNIX" && service.ProtectControlGroups == false && service.ReadWritePaths == [ "/sys/fs/cgroup" ];
    servicePins = lib.all (part: lib.hasInfix part service.ExecStart)
      [ "--broker-uid 1000" "--deployment reverie" "--policy /etc/reverie/soft-limit-policy.json" "--endpoint unix:///run/docker.sock" ];
    policyCopy = enabled.environment.etc."reverie/soft-limit-policy.json".mode == "0444" && policy == {
      v = 1; deployment = "reverie"; stateRoot = "/srv/reverie/state"; qualifiedKernel.osrelease = "6.18.39";
      entries = [ { employeeId = employee; home = "/srv/reverie/state/employees/${employee}/home"; memoryMaxMiB = 4096; memoryHighMiB = 3072; } ];
    };
    aggregateSlice = enabled.systemd.slices.reverie-soft-limit.sliceConfig.MemoryMax == "128M";
    unsupportedKernelRefused = failing oldKernel;
    attestedKernelAccepted = !(failing attested) &&
      (builtins.fromJSON attested.environment.etc."reverie/soft-limit-policy.json".text).qualifiedKernel.osrelease == "6.12.0";
    emptyAttestationRejected = !(builtins.tryEval (builtins.deepSeq emptyAttestation.services.reverieWorkers.softLimitHelper.backportAttested true)).success;
    highMustBeBelowMax = failing highAtMax;
    oneEntryPerEmployee = failing duplicate && !(failing (evaluate "6.18.39" (workers // { softLimitHelper = helper // {
      entries = helper.entries ++ [ { employeeId = other; memoryMaxMiB = 8192; memoryHighMiB = 6144; } ]; }; })));
  };
in assert builtins.all (result: result) (builtins.attrValues checks); {
  inherit checks;
}
