# Pure NixOS evaluation of the exported module's lease-acceptance unit; synthetic values, no host activation or unit start.
{ nixpkgs, leaseAcceptancePackage, pruneModule, system ? builtins.currentSystem }:
let
  lib = nixpkgs.lib;
  evaluate = extra: (import "${nixpkgs}/nixos/lib/eval-config.nix" {
    inherit system;
    modules = [ pruneModule { system.stateVersion = "26.05"; } extra ];
  }).config;
  employee = "11111111-1111-4111-8111-111111111111";
  deployment = { name = "fixture"; disposableMount = "/disposable"; laptopHomeRoot = "/durable/employees";
    employeeIds = [ employee ]; laptopUid = 1000; laptopGid = 1000;
    rootIdentities."/disposable" = { source = "/dev/fixture"; fstype = "ext4"; }; };
  leaseAcceptance = { enable = true; peerSocket = "/host/state/lease-peer/peer.sock"; brokerUid = 1000; peerEmployeeId = employee;
    peerImageId = "sha256:" + lib.concatStrings (lib.genList (_: "ab") 32); generation = lib.concatStrings (lib.genList (_: "cd") 32);
    companyFile = "/host/state/company.json"; brokerConfig = "/host/state/broker.json"; };
  failing = c: builtins.any (entry: !entry.assertion && lib.hasInfix "reverie" (lib.toLower entry.message)) c.assertions;
  off = evaluate { services.reverie.prune = { enable = true; inherit deployment; }; };
  on = evaluate { services.reverie.prune = { enable = true; inherit deployment leaseAcceptance;
    selftest = { enable = true; uid = 25001; gid = 25001; }; }; };
  strangerPeer = evaluate { services.reverie.prune = { enable = true; inherit deployment;
    leaseAcceptance = leaseAcceptance // { peerEmployeeId = "22222222-2222-4222-8222-222222222222"; }; }; };
  withoutPrune = evaluate { services.reverie.prune = { inherit deployment leaseAcceptance; }; };
  unit = on.systemd.services.reverie-prune-lease-acceptance;
  s = unit.serviceConfig;
  gate = builtins.fromJSON on.services.reverie.prune.leaseAcceptance.gateFile.text;
  checks = {
    defaultOff = !(off.systemd.services ? reverie-prune-lease-acceptance);
    declaredWhenEnabled = on.systemd.services ? reverie-prune-lease-acceptance;
    selftestPredecessorExists = builtins.elem "reverie-prune-lease-acceptance.service" on.systemd.services.reverie-prune-selftest.requires;
    noAutomaticStart = unit.wantedBy == [ ] && !(on.systemd.timers ? reverie-prune-lease-acceptance);
    hostNamespaceRun = lib.hasPrefix "+" s.ExecStart && lib.hasInfix "${leaseAcceptancePackage}/bin/reverie-prune-acceptance" s.ExecStart
      && lib.hasInfix "\"--config\"" s.ExecStart && lib.hasSuffix "\"--run\"" s.ExecStart && !(lib.hasInfix "--check" s.ExecStart);
    noOverriddenBindings = !(lib.hasInfix "--initializer" s.ExecStart) && !(lib.hasInfix "--docker" s.ExecStart) && !(lib.hasInfix "--peer-binary" s.ExecStart);
    boundedRootOneshot = s.Type == "oneshot" && s.User == "root" && s.KillMode == "control-group" && s.TimeoutStartSec == 600 && s.UMask == "0077";
    exactGateFields = builtins.attrNames gate == [ "brokerConfig" "brokerUid" "companyFile" "deploymentConfig" "generation" "peerBinary"
      "peerEmployeeId" "peerImageId" "peerSocket" "receiptLifetimeSeconds" "stateDirectory" "version" ];
    gateBindsModule = gate.version == 1 && gate.stateDirectory == on.services.reverie.prune.stateDirectory
      && gate.deploymentConfig == "${on.services.reverie.prune.deploymentConfigFile}"
      && gate.peerBinary == leaseAcceptancePackage.passthru.peerArtifactPath && gate.receiptLifetimeSeconds == 3600;
    sameDeploymentAsInitializer = lib.hasInfix "${on.services.reverie.prune.deploymentConfigFile}" on.systemd.services.reverie-prune.serviceConfig.ExecStartPre;
    strangerPeerRejected = failing strangerPeer;
    requiresPruneModule = failing withoutPrune;
  };
in assert builtins.all (value: value) (builtins.attrValues checks); {
  inherit checks;
  unitText = on.systemd.units."reverie-prune-lease-acceptance.service".text;
}
