# The host owns the aggregate ceiling. No container engine is used to change
# host policy. Ordinary NixOS owner activation is required to install this slice.
{ config, lib, pkgs, brokerPackage, softLimitHelperPackage ? null }:
let
  cfg = config.services.reverieWorkers;
  helper = cfg.softLimitHelper;
  kernel = config.boot.kernelPackages.kernel;
  policyFile = pkgs.writeText "reverie-soft-limit-policy.json" (builtins.toJSON {
    v = 1;
    deployment = helper.deployment;
    stateRoot = cfg.stateRoot;
    qualifiedKernel.osrelease = kernel.modDirVersion;
    entries = map (e: {
      employeeId = e.employeeId;
      home = "${cfg.stateRoot}/employees/${e.employeeId}/home";
      memoryMaxMiB = e.memoryMaxMiB;
      memoryHighMiB = e.memoryHighMiB;
    }) helper.entries;
  });
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
    softLimitHelper = {
      enable = lib.mkEnableOption "the root helper that applies owner-authorized laptop memory.high";
      deployment = lib.mkOption { type = lib.types.strMatching "[a-z0-9][a-z0-9-]{0,39}"; default = "reverie"; };
      brokerUid = lib.mkOption { type = lib.types.ints.positive; description = "The only uid allowed to connect."; };
      brokerGroup = lib.mkOption { type = lib.types.str; description = "Group that may open the helper socket."; };
      entries = lib.mkOption {
        default = [ ];
        description = "Owner-authorized (memory.max, memory.high) pairs, keyed by employee home path.";
        type = lib.types.listOf (lib.types.submodule { options = {
          employeeId = lib.mkOption { type = lib.types.strMatching "[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}"; };
          memoryMaxMiB = lib.mkOption { type = lib.types.ints.between 513 1048576; };
          memoryHighMiB = lib.mkOption { type = lib.types.ints.between 512 1048575; };
        }; });
      };
      backportAttested = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "For a kernel older than 6.16: the build identity and source reference proving memory_high_write honors O_NONBLOCK.";
      };
    };
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
    assertions = lib.optionals helper.enable [
      { assertion = softLimitHelperPackage != null; message = "softLimitHelper needs its package."; }
      { assertion = lib.versionAtLeast kernel.version "6.16" || helper.backportAttested != null;
        message = "softLimitHelper needs a kernel >= 6.16 or an attested O_NONBLOCK backport."; }
      { assertion = lib.all (e: e.memoryHighMiB < e.memoryMaxMiB) helper.entries;
        message = "softLimitHelper entries need memoryHighMiB below memoryMaxMiB."; }
      { assertion = lib.length (lib.unique (map (e: e.employeeId) helper.entries)) == lib.length helper.entries;
        message = "softLimitHelper entries need one entry per employee."; }
    ];
    environment.etc."reverie/soft-limit-policy.json" = lib.mkIf helper.enable { source = policyFile; mode = "0444"; };
    systemd.tmpfiles.rules = lib.mkIf helper.enable [ "d /run/reverie-soft-limit 0755 root root -" ];
    systemd.slices.reverie-soft-limit = lib.mkIf helper.enable {
      description = "Reverie soft-limit helper instances";
      sliceConfig = { MemoryMax = "128M"; TasksMax = 32; };
    };
    systemd.sockets.reverie-soft-limit = lib.mkIf helper.enable {
      wantedBy = [ "sockets.target" ];
      socketConfig = {
        ListenStream = "/run/reverie-soft-limit/soft-limit.sock";
        Accept = true;
        MaxConnections = 4;
        Backlog = 4;
        SocketUser = "root";
        SocketGroup = helper.brokerGroup;
        SocketMode = "0660";
        TriggerLimitIntervalSec = "10s";
        TriggerLimitBurst = 20;
      };
    };
    systemd.services."reverie-soft-limit@" = lib.mkIf helper.enable {
      description = "Reverie soft-limit helper (one connection)";
      serviceConfig = {
        Type = "exec";
        StandardInput = "socket";
        StandardOutput = "socket";
        StandardError = "journal";
        ExecStart = lib.concatStringsSep " " [
          "${softLimitHelperPackage}/bin/reverie-soft-limit-helper"
          "--broker-uid ${toString helper.brokerUid}"
          "--deployment ${helper.deployment}"
          "--engine ${pkgs.docker-client}/bin/docker"
          "--endpoint unix:///run/docker.sock"
          "--policy /etc/reverie/soft-limit-policy.json"
          "--state-root ${lib.escapeShellArg cfg.stateRoot}"
        ];
        Slice = "reverie-soft-limit.slice";
        MemoryMax = "48M";
        TasksMax = 8;
        RuntimeMaxSec = "10s";
        TimeoutStartSec = "5s";
        TimeoutStopSec = "2s";
        KillMode = "control-group";
        Restart = "no";
        CapabilityBoundingSet = "";
        NoNewPrivileges = true;
        PrivateNetwork = true;
        RestrictAddressFamilies = "AF_UNIX";
        ProtectSystem = "strict";
        ProtectHome = "read-only";
        ProtectControlGroups = false;
        ReadWritePaths = [ "/sys/fs/cgroup" ];
        UMask = "0077";
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
