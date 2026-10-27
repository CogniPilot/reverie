{ nixpkgs, observationsPackage, system ? builtins.currentSystem }:
let
  lib = nixpkgs.lib;
  evaluate = extra: (import "${nixpkgs}/nixos/lib/eval-config.nix" {
    inherit system;
    modules = [
      ({ config, lib, pkgs, ... }: import ../nix/collect-service.nix {
        inherit config lib pkgs observationsPackage;
      })
      { system.stateVersion = "26.05"; }
      extra
    ];
  }).config;
  off = evaluate { };
  on = evaluate { services.reverie.collect.enable = true; };
  scheduled = evaluate { services.reverie.collect = {
    enable = true; timer.enable = true; receipts.enable = true;
    pruneLogDirectory = "/var/lib/prune/logs";
  }; };
  bad = evaluate { services.reverie.collect.timer.enable = true; };
  service = on.systemd.services.reverie-collect;
  receiptService = scheduled.systemd.services.reverie-collect;
  checks = {
    defaultOff = !(off.systemd.services ? reverie-collect);
    noAutomaticRun = service.wantedBy == [ ] && on.systemd.timers.reverie-collect.wantedBy == [ ];
    explicitTimer = scheduled.systemd.timers.reverie-collect.wantedBy == [ "timers.target" ];
    boundedSandbox = service.serviceConfig.ProtectSystem == "strict" && service.serviceConfig.TimeoutStartSec == 90 && service.serviceConfig.TasksMax == 32;
    privateOutputOnly = service.serviceConfig.ReadWritePaths == "\"/var/lib/reverie-collect\"";
    safeInitializer = lib.hasPrefix "+\"${observationsPackage}/bin/reverie-collect-state\"" service.serviceConfig.ExecStartPre;
    noReceiptAuthority = service.serviceConfig.ExecStartPost == [ ] &&
      builtins.length receiptService.serviceConfig.ExecStartPost == 1 &&
      !(lib.hasInfix "--context" (builtins.head receiptService.serviceConfig.ExecStartPost));
    timerRequiresService = builtins.any (a: !a.assertion) bad.assertions;
  };
in assert builtins.all (x: x) (builtins.attrValues checks); checks
