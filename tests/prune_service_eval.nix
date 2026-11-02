# Pure NixOS evaluation, with synthetic paths and no host activation.
{ nixpkgs, pruneHostPackage, prunePackage, legacyPrunePackage, system ? builtins.currentSystem }:
let
  lib = nixpkgs.lib;
  evaluateWith = package: extra: import "${nixpkgs}/nixos/lib/eval-config.nix" {
    inherit system;
    modules = [
      ({ config, lib, pkgs, ... }: import ../nix/prune-service.nix {
        inherit config lib pkgs pruneHostPackage;
        prunePackage = package;
      })
      { system.stateVersion = "26.05"; }
      extra
    ];
  };
  evaluate = evaluateWith prunePackage;
  deployment = {
    name = "fixture";
    disposableMount = "/disposable";
    laptopHomeRoot = "/durable/employees";
    employeeIds = [ "11111111-1111-4111-8111-111111111111" ];
    laptopUid = 1000;
    laptopGid = 1000;
    rootIdentities."/disposable" = { source = "/dev/fixture"; fstype = "ext4"; };
  };
  acceptance = {
    enable = true;
    acceptedDryRunReportSha256 = lib.concatStrings (lib.genList (_: "ab") 32);
    signoff = "reviewer: record-1";
    selfTestReceipt = "/var/lib/reverie-prune-declared-dry/selftest-receipt.json";
    selfTestReceiptSha256 = lib.concatStrings (lib.genList (_: "cd") 32);
  };
  # Only this module's assertions: a synthetic evaluation also fails unrelated NixOS base checks (no root filesystem).
  failing = c: builtins.any (entry: !entry.assertion && lib.hasInfix "reverie" (lib.toLower entry.message)) c.assertions;
  liveConfig = (evaluate { services.reverie.prune = { enable = true; inherit deployment; live = acceptance; }; }).config;
  liveService = liveConfig.systemd.services.reverie-prune;
  liveText = liveConfig.systemd.units."reverie-prune.service".text;
  liveNoAcceptance = (evaluate { services.reverie.prune = { enable = true; inherit deployment; live.enable = true; }; }).config;
  liveOldPackage = (evaluateWith legacyPrunePackage { services.reverie.prune = { enable = true; inherit deployment; live = acceptance; }; }).config;
  liveCheckouts = (evaluate { services.reverie.prune = {
    enable = true; live = acceptance;
    deployment = deployment // { checkoutRoots = [ "/src" ]; rootIdentities = deployment.rootIdentities // { "/src" = { source = "/dev/src"; fstype = "ext4"; }; }; };
  }; }).config;
  liveWithoutService = (evaluate { services.reverie.prune.live = acceptance; }).config;
  liveNoReceipt = (evaluate { services.reverie.prune = { enable = true; inherit deployment; live = removeAttrs acceptance [ "selfTestReceipt" "selfTestReceiptSha256" ]; }; }).config;
  liveReceiptInsideState = (evaluate { services.reverie.prune = { enable = true; inherit deployment;
    live = acceptance // { selfTestReceipt = "/var/lib/reverie-prune-declared/selftest-receipt.json"; }; }; }).config;
  noIdentity = (evaluate { services.reverie.prune = { enable = true; deployment = removeAttrs deployment [ "rootIdentities" ]; }; }).config;
  subtreeIdentity = (evaluate { services.reverie.prune = { enable = true; deployment = deployment // { rootIdentities."/disposable" = { source = "/dev/fixture"; fstype = "ext4"; mountRoot = "/sub"; }; }; }; }).config;
  disabled = (evaluate { }).config;
  enabled = (evaluate { services.reverie.prune = { enable = true; inherit deployment; }; }).config;
  scheduled = (evaluate { services.reverie.prune = { enable = true; timer.enable = true; inherit deployment; }; }).config;
  badWater = (evaluate { services.reverie.prune = { enable = true; deployment = deployment // { lowWaterPercent = 90; highWaterPercent = 50; }; }; }).config;
  badTimer = (evaluate { services.reverie.prune.timer.enable = true; }).config;
  specialPaths = (evaluate { services.reverie.prune = {
    enable = true;
    stateDirectory = "/var/lib/prune %$ state";
    inherit deployment;
  }; }).config;
  invalidPath = builtins.tryEval (builtins.deepSeq (evaluate {
    services.reverie.prune = { enable = true; deployment = deployment // { laptopHomeRoot = "/agent/../durable"; }; };
  }).config.services.reverie.prune.deployment.laptopHomeRoot true);
  service = enabled.systemd.services.reverie-prune;
  serviceText = enabled.systemd.units."reverie-prune.service".text;
  timerText = scheduled.systemd.units."reverie-prune.timer".text;
  checks = {
    defaultOff = !disabled.services.reverie.prune.enable && !disabled.services.reverie.prune.timer.enable && !(disabled.systemd.services ? reverie-prune);
    serviceNotAutomaticallyStarted = service.wantedBy == [ ] && !service.restartIfChanged && !service.stopIfChanged;
    unscheduledByDefault = enabled.systemd.timers.reverie-prune.wantedBy == [ ];
    scheduledOnlyExplicitly = scheduled.systemd.timers.reverie-prune.wantedBy == [ "timers.target" ];
    fixedDryRun = lib.hasInfix "--dry-run" serviceText && !(lib.hasInfix "--live" serviceText) && lib.hasInfix "reverie-prune-declared" serviceText;
    exactR12 = prunePackage.sourceHashes.prune == "55f26deec48c2c5d25b7d2509aa2ec28a22b1ebb0a6747c8be021a79129d4bed" &&
      prunePackage.sourceHashes.lease == "606cacea83ebb70bb805423e67be44168fec411d3e5c62c5e563c416ab6891aa" &&
      pruneHostPackage.sourceHashes == prunePackage.sourceHashes &&
      lib.hasPrefix "\"${prunePackage}/bin/reverie-prune\"" service.serviceConfig.ExecStart &&
      lib.hasPrefix "+\"${pruneHostPackage}/bin/reverie-prune-declared\"" service.serviceConfig.ExecStartPre;
    rootAndHostVisibility = service.serviceConfig.User == "root" && !service.serviceConfig.PrivateUsers && !service.serviceConfig.PrivateTmp && service.serviceConfig.ProtectProc == "default" && service.serviceConfig.ProcSubset == "all";
    initializerSeesHostMounts = lib.hasPrefix "+\"${pruneHostPackage}/bin/reverie-prune-declared\"" service.serviceConfig.ExecStartPre &&
      !(lib.hasPrefix "+" service.serviceConfig.ExecStart) &&
      !(builtins.any (rule: lib.hasInfix "reverie-prune-declared" rule) enabled.systemd.tmpfiles.rules);
    fixedInventoryOnly = !(enabled.services.reverie.prune.deployment ? laptops_cmd);
    badWatermarkRejected = builtins.any (entry: !entry.assertion) badWater.assertions;
    timerRequiresService = builtins.any (entry: !entry.assertion) badTimer.assertions;
    noncanonicalPathRejected = !invalidPath.success;
    enabledAssertionsHold = !(failing enabled) && !(failing liveConfig);
    dryRunKeepsDisposableReadOnly = lib.hasInfix "/disposable" service.serviceConfig.ReadOnlyPaths && !(lib.hasInfix "/disposable" service.serviceConfig.ReadWritePaths);
    liveIsExplicitAndGated = lib.hasInfix "reverie-prune-live" liveText && lib.hasInfix "--live" liveText && !(lib.hasInfix "--dry-run" liveText) &&
      lib.hasInfix "/disposable" liveService.serviceConfig.ReadWritePaths && !(lib.hasInfix "/disposable" liveService.serviceConfig.ReadOnlyPaths);
    liveNeedsAcceptance = failing liveNoAcceptance;
    liveNeedsPinnedCandidate = failing liveOldPackage;
    liveExcludesCheckouts = failing liveCheckouts;
    liveNeedsService = failing liveWithoutService;
    liveNeedsSelfTestReceipt = failing liveNoReceipt && failing liveReceiptInsideState;
    rootIdentityRequired = failing noIdentity && failing subtreeIdentity;
    pathEscaping = lib.hasInfix "prune %%$$ state" specialPaths.systemd.services.reverie-prune.serviceConfig.ExecStartPre &&
      lib.hasInfix "prune %%$ state" specialPaths.systemd.services.reverie-prune.serviceConfig.ReadWritePaths;
  };
in assert builtins.all (result: result) (builtins.attrValues checks); {
  inherit checks serviceText timerText;
}
