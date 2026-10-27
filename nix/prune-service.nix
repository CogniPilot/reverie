# Root cleanup authority is granted only by ordinary owner NixOS activation.
# Both switches are opt-in; every executable and inventory command is fixed.
{ config, lib, pkgs, pruneHostPackage, prunePackage }:
let
  cfg = config.services.reverie.prune;
  inherit (lib) mkOption types;
  canonical = absolute: value:
    builtins.isString value && value != "" &&
    (lib.hasPrefix "/" value == absolute) &&
    !(lib.hasInfix "//" value) &&
    builtins.all (part: part != "." && part != "..") (lib.splitString "/" value) &&
    !(lib.hasSuffix "/" value) &&
    builtins.match ".*[[:cntrl:]].*" value == null;
  absolutePath = types.addCheck types.str (canonical true);
  relativePath = types.addCheck types.str (canonical false);
  employeeId = types.strMatching "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  argument = value: builtins.replaceStrings [ "%" "$" ] [ "%%" "$$" ] (builtins.toJSON (toString value));
  arguments = lib.concatMapStringsSep " " argument;
  pathArgument = value: builtins.replaceStrings [ "%" ] [ "%%" ] (builtins.toJSON value);
  paths = lib.concatMapStringsSep " " pathArgument;
  d = cfg.deployment;
  settings = pkgs.writeText "reverie-prune-declared-deployment.json" (builtins.toJSON {
    version = 1;
    deployment = d.name;
    b_mount = d.disposableMount;
    laptops_root = d.laptopsRoot;
    laptop_home_root = d.laptopHomeRoot;
    employee_ids = d.employeeIds;
    laptop_uid = d.laptopUid;
    laptop_gid = d.laptopGid;
    checkout_roots = d.checkoutRoots;
    lease_subdir = d.leaseSubdirectory;
    docker_socket = d.dockerSocket;
    high_water_pct = d.highWaterPercent;
    low_water_pct = d.lowWaterPercent;
    cadence = cfg.cadence;
    live_enabled = false;
  });
  leases = map (eid: "${d.laptopHomeRoot}/${eid}/home/${d.leaseSubdirectory}") d.employeeIds;
in {
  options.services.reverie.prune = {
    enable = lib.mkEnableOption "the NixOS-declared Reverie dry-run cleanup service";
    timer.enable = lib.mkEnableOption "scheduled dry-run observations (only after owner host/lease acceptance)";
    stateDirectory = mkOption {
      type = absolutePath;
      default = "/var/lib/reverie-prune-declared";
      description = "Dedicated root-controlled state. Existing state is never adopted or upgraded; changed bindings require a fresh owner-declared directory.";
    };
    cadence = mkOption { type = types.enum [ "hourly" "daily" "half-hourly" ]; default = "hourly"; };
    deployment = {
      name = mkOption { type = types.strMatching "[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}"; description = "Owner-reviewed worker deployment label."; };
      disposableMount = mkOption { type = absolutePath; description = "Existing disposable filesystem mount; runtime checks refuse / and symlink paths."; };
      laptopsRoot = mkOption { type = relativePath; default = "laptops/employees"; };
      laptopHomeRoot = mkOption { type = absolutePath; description = "Persistent employee root outside the disposable filesystem."; };
      employeeIds = mkOption { type = types.listOf employeeId; description = "Reviewed canonical employee UUIDs; no display names or session IDs."; };
      laptopUid = mkOption { type = types.ints.positive; description = "Non-root laptop user UID."; };
      laptopGid = mkOption { type = types.ints.positive; description = "Non-root laptop user GID."; };
      checkoutRoots = mkOption { type = types.listOf absolutePath; default = [ ]; };
      leaseSubdirectory = mkOption { type = relativePath; default = ".local/state/reverie/leases"; };
      dockerSocket = mkOption { type = absolutePath; default = "/run/docker.sock"; };
      highWaterPercent = mkOption { type = types.ints.between 0 100; default = 70; };
      lowWaterPercent = mkOption { type = types.ints.between 0 100; default = 50; };
    };
  };
  config = lib.mkMerge [
    { assertions = [{ assertion = !cfg.timer.enable || cfg.enable; message = "services.reverie.prune.timer.enable requires services.reverie.prune.enable"; }]; }
    (lib.mkIf cfg.enable {
      assertions = [
        { assertion = builtins.length d.employeeIds >= 1 && builtins.length d.employeeIds <= 256 && lib.unique d.employeeIds == d.employeeIds;
          message = "Reverie prune requires 1..256 unique reviewed employee UUIDs."; }
        { assertion = d.lowWaterPercent <= d.highWaterPercent; message = "Reverie prune low watermark must not exceed high watermark."; }
      ];
      systemd.services.reverie-prune = {
        description = "Reverie cleanup observation (declared dry-run only)";
        after = [ "docker.service" ];
        # A host switch must not stop/restart a running cleanup oneshot.
        restartIfChanged = false;
        stopIfChanged = false;
        unitConfig.RequiresMountsFor = paths [ d.disposableMount d.laptopHomeRoot ];
        serviceConfig = {
          Type = "oneshot";
          User = "root";
          Group = "root";
          UMask = "0077";
          # Validate real host mounts and custody before entering the janitor's
          # bind-mount sandbox. Only this fixed root initializer bypasses its
          # filesystem namespace; it also creates absent state after validation.
          ExecStartPre = "+" + arguments [ "${pruneHostPackage}/bin/reverie-prune-declared" "--state-dir" cfg.stateDirectory "--config" settings ];
          ExecStart = arguments [ "${prunePackage}/bin/reverie-prune" "--config" "${cfg.stateDirectory}/prune.toml" "--dry-run" "--pass" "all" ];
          TimeoutStartSec = 600;
          MemoryMax = "1G";
          TasksMax = 64;
          CPUQuota = "100%";
          Nice = 19;
          IOSchedulingClass = "idle";
          NoNewPrivileges = true;
          PrivateTmp = false;
          PrivateUsers = false;
          ProtectProc = "default";
          ProcSubset = "all";
          ProtectSystem = "strict";
          ReadWritePaths = paths ([ cfg.stateDirectory ] ++ leases);
          ReadOnlyPaths = paths [ d.disposableMount d.laptopHomeRoot ];
          StandardOutput = "journal";
          StandardError = "journal";
        };
      };
      systemd.timers.reverie-prune = {
        description = "Reverie declared dry-run observation timer";
        wantedBy = lib.optional cfg.timer.enable "timers.target";
        timerConfig = {
          OnCalendar = { hourly = "hourly"; daily = "daily"; half-hourly = "*-*-* *:00,30:00"; }.${cfg.cadence};
          Persistent = false;
          AccuracySec = "1min";
          Unit = "reverie-prune.service";
        };
      };
    })
  ];
}
