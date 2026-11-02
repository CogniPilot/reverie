# Real host/laptop lease acceptance: the predecessor the phase-3 selftest unit requires. Root runs the pinned package once,
# when the owner starts this unit. No timer, no automatic start, no live cleanup authority.
{ config, lib, pkgs, leaseAcceptancePackage }:
let
  p = config.services.reverie.prune;
  cfg = p.leaseAcceptance;
  d = p.deployment;
  inherit (lib) mkOption types;
  canonical = value:
    builtins.isString value && lib.hasPrefix "/" value && !(lib.hasInfix "//" value) && !(lib.hasSuffix "/" value) &&
    builtins.all (part: part != "." && part != "..") (lib.splitString "/" value) &&
    builtins.match ".*[[:cntrl:]].*" value == null;
  absolutePath = types.addCheck types.str canonical;
  argument = value: builtins.replaceStrings [ "%" "$" ] [ "%%" "$$" ] (builtins.toJSON (toString value));
  arguments = lib.concatMapStringsSep " " argument;
  pathArgument = value: builtins.replaceStrings [ "%" ] [ "%%" ] (builtins.toJSON value);
  # Exactly the fields acceptance.py accepts (CONFIG_FIELDS); immutable in the store, as it requires.
  gate = pkgs.writeText "reverie-lease-acceptance.json" (builtins.toJSON {
    version = 1;
    stateDirectory = p.stateDirectory;
    deploymentConfig = "${p.deploymentConfigFile}";
    peerSocket = cfg.peerSocket;
    brokerUid = cfg.brokerUid;
    peerEmployeeId = cfg.peerEmployeeId;
    peerBinary = leaseAcceptancePackage.passthru.peerArtifactPath;
    peerImageId = cfg.peerImageId;
    generation = cfg.generation;
    receiptLifetimeSeconds = cfg.receiptLifetimeSeconds;
    companyFile = cfg.companyFile;
    brokerConfig = cfg.brokerConfig;
  });
in {
  options.services.reverie.prune.leaseAcceptance = {
    enable = lib.mkEnableOption "the real host/laptop lease acceptance unit (started only on request)";
    peerSocket = mkOption { type = absolutePath; description = "Peer socket of the accepting laptop's broker."; };
    brokerUid = mkOption { type = types.ints.positive; description = "Non-root UID of that broker."; };
    peerEmployeeId = mkOption {
      type = types.strMatching "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
      description = "Reviewed employee UUID of the accepting laptop; one of deployment.employeeIds.";
    };
    peerImageId = mkOption { type = types.strMatching "sha256:[0-9a-f]{64}"; description = "Immutable image id of that laptop's running container."; };
    generation = mkOption { type = types.strMatching "[0-9a-f]{64}"; description = "Owner-chosen 64-hex generation; a new value invalidates earlier acceptance."; };
    receiptLifetimeSeconds = mkOption { type = types.ints.between 60 86400; default = 3600; };
    gateFile = mkOption { type = types.package; internal = true; readOnly = true; description = "The generated acceptance configuration."; };
    companyFile = mkOption { type = absolutePath; description = "Canonical private company registry the broker reads."; };
    brokerConfig = mkOption { type = absolutePath; description = "The broker's current private declaration."; };
  };
  config = lib.mkMerge [ { services.reverie.prune.leaseAcceptance.gateFile = gate; } (lib.mkIf cfg.enable {
    assertions = [
      { assertion = p.enable; message = "Reverie lease acceptance requires the declared cleanup module (services.reverie.prune.enable)."; }
      { assertion = builtins.elem cfg.peerEmployeeId d.employeeIds; message = "Reverie lease acceptance peerEmployeeId must be one of deployment.employeeIds."; }
    ];
    systemd.services.reverie-prune-lease-acceptance = {
      description = "Real host/laptop lease acceptance before the cleanup selftest";
      restartIfChanged = false; stopIfChanged = false;
      unitConfig.RequiresMountsFor = pathArgument d.disposableMount;
      serviceConfig = {
        Type = "oneshot"; User = "root"; Group = "root"; UMask = "0077";
        # Actual host namespace and PID view ("+"): the package requires PID 1 to be systemd and reads the running fleet.
        ExecStart = "+" + arguments [ "${leaseAcceptancePackage}/bin/reverie-prune-acceptance" "--config" gate "--run" ];
        NoNewPrivileges = true; KillMode = "control-group"; TimeoutStartSec = 600; MemoryMax = "512M"; TasksMax = 64;
      };
    };
  }) ];
}
