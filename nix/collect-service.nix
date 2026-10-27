# Resource observations are independent of permission to run a janitor.
{ config, lib, pkgs, observationsPackage }:
let
  cfg = config.services.reverie.collect;
  absolute = lib.types.addCheck lib.types.str (value:
    lib.hasPrefix "/" value && !(lib.hasInfix "//" value) &&
    builtins.all (part: part != "." && part != "..") (lib.splitString "/" value) &&
    (value == "/" || !(lib.hasSuffix "/" value)) &&
    builtins.match ".*[[:cntrl:]].*" value == null);
  argument = value: builtins.replaceStrings [ "%" "$" ] [ "%%" "$$" ] (builtins.toJSON (toString value));
  arguments = lib.concatMapStringsSep " " argument;
  file = (pkgs.formats.toml { }).generate "reverie-collect.toml" {
    out_dir = cfg.stateDirectory;
    label = cfg.label;
    interval_s = cfg.intervalSeconds;
    retention_days = cfg.retentionDays;
    rollup_retention_days = cfg.rollupRetentionDays;
    drives = cfg.drives;
    prune_log_dir = if cfg.pruneLogDirectory == null then "" else cfg.pruneLogDirectory;
    gpu = if cfg.gpuPackage == null then "off" else "auto";
    nvidia_smi = if cfg.gpuPackage == null then "/disabled/nvidia-smi" else "${cfg.gpuPackage}/bin/nvidia-smi";
  };
in {
  options.services.reverie.collect = {
    enable = lib.mkEnableOption "the root-controlled Reverie resource observation service";
    timer.enable = lib.mkEnableOption "periodic resource observations";
    receipts.enable = lib.mkEnableOption "path-free unauthenticated producer receipts (observations only)";
    stateDirectory = lib.mkOption { type = absolute; default = "/var/lib/reverie-collect"; };
    label = lib.mkOption { type = lib.types.strMatching "[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"; default = "reverie"; };
    intervalSeconds = lib.mkOption { type = lib.types.ints.between 30 86400; default = 300; };
    retentionDays = lib.mkOption { type = lib.types.ints.between 1 365; default = 30; };
    rollupRetentionDays = lib.mkOption { type = lib.types.ints.between 1 3650; default = 400; };
    drives = lib.mkOption { type = lib.types.attrsOf absolute; default = { }; };
    pruneLogDirectory = lib.mkOption { type = lib.types.nullOr absolute; default = null; };
    gpuPackage = lib.mkOption { type = lib.types.nullOr lib.types.package; default = null; description = "Owner-selected package with matching nvidia-smi; GPU sampling is off when absent."; };
  };
  config = lib.mkMerge [
    { assertions = [
      { assertion = !cfg.timer.enable || cfg.enable; message = "Reverie collection timer requires the service."; }
      { assertion = !cfg.receipts.enable || (cfg.enable && cfg.pruneLogDirectory != null); message = "Observation receipts require collection and an explicit prune log directory."; }
    ]; }
    (lib.mkIf cfg.enable {
      systemd.services.reverie-collect = {
        description = "Reverie resource observations";
        restartIfChanged = false;
        stopIfChanged = false;
        serviceConfig = {
          Type = "oneshot";
          User = "root";
          Group = "root";
          UMask = "0077";
          ExecStartPre = "+" + arguments [ "${observationsPackage}/bin/reverie-collect-state" "--state-dir" cfg.stateDirectory ];
          ExecStart = arguments [ "${observationsPackage}/bin/reverie-collect" "--config" file "once" ];
          ExecStartPost = lib.optional cfg.receipts.enable (arguments [
            "${observationsPackage}/bin/reverie-prune-receipts" "--log-dir" cfg.pruneLogDirectory
            "--out" "${cfg.stateDirectory}/producer-receipts.jsonl"
          ]);
          TimeoutStartSec = 90;
          MemoryMax = "256M";
          TasksMax = 32;
          CPUQuota = "50%";
          Nice = 19;
          IOSchedulingClass = "idle";
          NoNewPrivileges = true;
          ProtectSystem = "strict";
          ProtectProc = "default";
          ProcSubset = "all";
          PrivateUsers = false;
          PrivateTmp = false;
          ReadWritePaths = arguments [ cfg.stateDirectory ];
          StandardOutput = "journal";
          StandardError = "journal";
        };
      };
      systemd.timers.reverie-collect = {
        description = "Reverie periodic resource observations";
        wantedBy = lib.optional cfg.timer.enable "timers.target";
        timerConfig = {
          OnBootSec = "${toString cfg.intervalSeconds}s";
          OnUnitActiveSec = "${toString cfg.intervalSeconds}s";
          Persistent = false;
          AccuracySec = "5s";
          Unit = "reverie-collect.service";
        };
      };
    })
  ];
}
