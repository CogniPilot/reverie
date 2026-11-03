# Root cleanup authority is granted only by ordinary owner NixOS activation.
# Every switch is opt-in; every executable and inventory command is fixed.
# Live deletion is a third, separate switch: it needs the digest of an accepted clean dry-run report and a named
# reviewer sign-off, and it is refused at evaluation unless the package is the pinned r12 live-capable candidate.
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
  within = parent: child: child == parent || lib.hasPrefix "${parent}/" child;
  live = cfg.live;
  liveCandidate = "55f26deec48c2c5d25b7d2509aa2ec28a22b1ebb0a6747c8be021a79129d4bed";
  liveCapable = (prunePackage.passthru.sourceHashes.prune or null) == liveCandidate &&
    (prunePackage.passthru.liveEntry or null) != null;
  identity = types.submodule {
    options = {
      source = mkOption { type = types.strMatching "[^[:cntrl:][:space:]]{1,256}"; description = "Approved mount source, exactly as /proc/self/mountinfo reports it."; };
      fstype = mkOption { type = types.strMatching "[a-z0-9._-]{1,32}"; description = "Approved filesystem type."; };
      mountRoot = mkOption { type = types.addCheck types.str (value: value == "/" || canonical true value); default = "/"; description = "Approved root within the filesystem; the disposable mount must map the full root."; };
    };
  };
  settings = pkgs.writeText "reverie-prune-declared-deployment.json" (builtins.toJSON ({
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
    root_identities = lib.mapAttrs (_: v: { inherit (v) source fstype; mount_root = v.mountRoot; }) d.rootIdentities;
    live_enabled = live.enable;
  } // lib.optionalAttrs live.enable {
    live_acceptance = {
      dry_run_report_sha256 = live.acceptedDryRunReportSha256;
      signoff = live.signoff;
      selftest_receipt = live.selfTestReceipt;
      selftest_receipt_sha256 = live.selfTestReceiptSha256;
    };
  }));
  reportExport = ../python/reverie/cleanup/report_export.py;
  leases = map (eid: "${d.laptopHomeRoot}/${eid}/home/${d.leaseSubdirectory}") d.employeeIds;
in {
  options.services.reverie.prune = {
    enable = lib.mkEnableOption "the NixOS-declared Reverie cleanup service (dry-run unless live.enable)";
    timer.enable = lib.mkEnableOption "scheduled dry-run observations (only after owner host/lease acceptance)";
    stateDirectory = mkOption {
      type = absolutePath;
      default = "/var/lib/reverie-prune-declared";
      description = "Dedicated root-controlled state. Existing state is never adopted or upgraded; changed bindings require a fresh owner-declared directory.";
    };
    cadence = mkOption { type = types.enum [ "hourly" "daily" "half-hourly" ]; default = "hourly"; };
    deploymentConfigFile = mkOption {
      type = types.package;
      internal = true;
      readOnly = true;
      description = "The declared deployment file this module generates; the initializer and lease acceptance read exactly this file.";
    };
    report = {
      directory = mkOption {
        type = types.nullOr absolutePath;
        default = null;
        description = "Existing directory that receives an aggregate of every run (status, counts, space, duration; no paths or laptop ids), written as report.uid. Outside the state directory and the disposable filesystem.";
      };
      uid = mkOption { type = types.nullOr types.ints.positive; default = null; description = "Non-root user that owns report.directory and writes the reports."; };
      gid = mkOption { type = types.nullOr types.ints.positive; default = null; description = "Group of that user."; };
    };
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
      rootIdentities = mkOption {
        type = types.attrsOf identity;
        default = { };
        description = "Operator-approved mount identity of disposableMount and of every checkout root (prune r12 admission, also in dry-run). Keyed by the exact configured path.";
      };
    };
    live = {
      enable = lib.mkEnableOption "live deletion (only after an accepted clean dry-run report and reviewer sign-off)";
      acceptedDryRunReportSha256 = mkOption {
        type = types.nullOr (types.strMatching "[0-9a-f]{64}");
        default = null;
        description = "sha256 of the accepted clean dry-run report that this live enablement is based on.";
      };
      signoff = mkOption {
        type = types.nullOr (types.strMatching "[^[:cntrl:]]{1,256}");
        default = null;
        description = "Reviewer sign-off record for live enablement (who, and where the record is kept).";
      };
      selfTestReceipt = mkOption {
        type = types.nullOr absolutePath;
        default = null;
        description = "Root-controlled module self-test receipt (status PASS for this exact prune and lease), outside the live stateDirectory; the initializer verifies it and keeps a digest-pinned copy.";
      };
      selfTestReceiptSha256 = mkOption {
        type = types.nullOr (types.strMatching "[0-9a-f]{64}");
        default = null;
        description = "sha256 of that self-test receipt.";
      };
    };
  };
  config = lib.mkMerge [
    { services.reverie.prune.deploymentConfigFile = settings; }
    { assertions = [
        { assertion = !cfg.timer.enable || cfg.enable; message = "services.reverie.prune.timer.enable requires services.reverie.prune.enable"; }
        { assertion = !live.enable || cfg.enable; message = "services.reverie.prune.live.enable requires services.reverie.prune.enable"; }
        { assertion = !live.enable || (live.acceptedDryRunReportSha256 != null && live.signoff != null &&
            live.selfTestReceipt != null && live.selfTestReceiptSha256 != null);
          message = "services.reverie.prune.live.enable requires live.acceptedDryRunReportSha256, live.signoff, live.selfTestReceipt and live.selfTestReceiptSha256"; }
        { assertion = !live.enable || live.selfTestReceipt == null || !(lib.hasPrefix (cfg.stateDirectory + "/") live.selfTestReceipt);
          message = "services.reverie.prune.live.selfTestReceipt must be outside the (fresh) live stateDirectory"; }
        { assertion = !live.enable || cfg.deployment.checkoutRoots == [ ];
          message = "services.reverie.prune.live.enable does not yet cover checkout roots (registry approvals and write scope are a separate review)"; }
        { assertion = !live.enable || liveCapable;
          message = "services.reverie.prune.live.enable requires the pinned live-capable r12 package (55f26dee)"; }
      ]; }
    (lib.mkIf cfg.enable {
      assertions = [
        { assertion = builtins.length d.employeeIds >= 1 && builtins.length d.employeeIds <= 256 && lib.unique d.employeeIds == d.employeeIds;
          message = "Reverie prune requires 1..256 unique reviewed employee UUIDs."; }
        { assertion = d.lowWaterPercent <= d.highWaterPercent; message = "Reverie prune low watermark must not exceed high watermark."; }
        { assertion = (d.rootIdentities.${d.disposableMount} or null) != null && d.rootIdentities.${d.disposableMount}.mountRoot == "/";
          message = "Reverie prune requires deployment.rootIdentities for disposableMount, mapping the full filesystem root."; }
        { assertion = builtins.all (root: d.rootIdentities ? ${root}) d.checkoutRoots;
          message = "Reverie prune requires deployment.rootIdentities for every checkout root."; }
        { assertion = cfg.report.directory == null || builtins.all (parent: !(within parent cfg.report.directory) && !(within cfg.report.directory parent))
            [ cfg.stateDirectory d.disposableMount ];
          message = "Reverie prune report.directory must be outside the state directory and the disposable filesystem."; }
        { assertion = cfg.report.directory == null || (cfg.report.uid != null && cfg.report.gid != null);
          message = "Reverie prune report.directory requires report.uid and report.gid (a non-root writer)."; }
      ];
      systemd.services.reverie-prune = {
        description = if live.enable then "Reverie cleanup (declared, live deletion enabled)" else "Reverie cleanup observation (declared dry-run only)";
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
          ExecStart = if live.enable
            then arguments [ "${prunePackage}/bin/${prunePackage.passthru.liveEntry}" "--config" "${cfg.stateDirectory}/prune.toml" "--live" "--pass" "all" ]
            else arguments [ "${prunePackage}/bin/reverie-prune" "--config" "${cfg.stateDirectory}/prune.toml" "--dry-run" "--pass" "all" ];
          TimeoutStartSec = 600;
        } // lib.optionalAttrs (cfg.report.directory != null) {
          # After success or failure, outside the sandbox like the initializer: reads only the newest run summary and
          # writes its aggregate as report.uid.
          ExecStopPost = "+" + arguments [ "${pkgs.python3}/bin/python3" "-I" "-B" reportExport "--state" cfg.stateDirectory
            "--out" cfg.report.directory "--uid" cfg.report.uid "--gid" cfg.report.gid ];
        } // {
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
          # Only live deletion may write the disposable filesystem; dry-run keeps it read-only.
          ReadWritePaths = paths ([ cfg.stateDirectory ] ++ leases ++ lib.optional live.enable d.disposableMount);
          ReadOnlyPaths = paths ([ d.laptopHomeRoot ] ++ lib.optional (!live.enable) d.disposableMount);
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
