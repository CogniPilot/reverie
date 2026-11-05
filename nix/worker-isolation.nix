# The host owns the aggregate ceiling. No container engine is used to change
# host policy. Ordinary NixOS owner activation is required to install this slice.
{ config, lib, pkgs, brokerPackage }:
let cfg = config.services.reverieWorkers;
in {
  options.services.reverieWorkers = {
    enable = lib.mkEnableOption "Reverie agent resource isolation";
    user = lib.mkOption { type = lib.types.str; description = "Existing host owner with authorized access to the container engine."; };
    configFile = lib.mkOption { type = lib.types.str; description = "Owner-only broker configuration outside the Nix store."; };
    stateRoot = lib.mkOption { type = lib.types.str; description = "Persistent private worker homes and per-laptop Nix stores/databases; outside scratch and shared mounts."; };
    socketDirectory = lib.mkOption { type = lib.types.str; description = "Private directory mounted only into the console."; };
    scratchRoot = lib.mkOption { type = lib.types.str; description = "Owner-selected laptop scratch drive."; };
    apiSocketRoot = lib.mkOption { type = lib.types.str; description = "Private per-laptop office connections."; };
    poolMemoryMiB = lib.mkOption { type = lib.types.ints.positive; description = "Shared hard memory ceiling; leave host and console headroom."; };
    poolTasksMax = lib.mkOption { type = lib.types.ints.positive; default = 8192; };
    laptopSwapPoolMiB = lib.mkOption {
      type = lib.types.ints.between 0 1048576;
      default = 0;
      description = "Slice swap ceiling; set it to the broker's laptopSwapPoolMiB. Zero keeps the pool swap-free.";
    };
  };
  config = lib.mkIf cfg.enable {
    systemd.slices.reverie-workers = {
      description = "Reverie agents (console and host remain outside this budget)";
      sliceConfig = {
        MemoryAccounting = true;
        MemoryHigh = "${toString (builtins.div (cfg.poolMemoryMiB * 9) 10)}M";
        MemoryMax = "${toString cfg.poolMemoryMiB}M";
        # Laptop swap allowances need an ancestor ceiling at least as large.
        MemorySwapMax = if cfg.laptopSwapPoolMiB == 0 then 0 else "${toString cfg.laptopSwapPoolMiB}M";
        TasksMax = cfg.poolTasksMax;
        CPUWeight = 100; # Work-conserving, no CPU quota.
      };
    };
    systemd.services.reverie-worker-broker = {
      description = "Reverie host worker broker";
      wantedBy = [ "multi-user.target" ];
      requires = [ "docker.service" "reverie-workers.slice" ];
      after = [ "docker.service" "reverie-workers.slice" ];
      path = [ pkgs.docker-client ];
      serviceConfig = {
        User = cfg.user;
        ExecStart = "${brokerPackage}/bin/reverie-worker-broker --config ${lib.escapeShellArg cfg.configFile}";
        Restart = "on-failure";
        RestartSec = 5;
        TimeoutStopSec = 35;
        KillMode = "mixed";
        UMask = "0077";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = "read-only";
        ReadWritePaths = [ cfg.stateRoot cfg.socketDirectory cfg.scratchRoot cfg.apiSocketRoot ];
        MemoryMax = "512M";
        # Docker attach clients and Python HTTP handlers all count as tasks.
        # Retain the effective deployed limit; capacity expansion needs measurement.
        TasksMax = 512;
      };
    };
  };
}
