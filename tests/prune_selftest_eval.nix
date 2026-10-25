{ nixpkgs, selftestPackage, prunePackage, pruneHostPackage, pruneModule ? null, system ? builtins.currentSystem }:
let
  lib = nixpkgs.lib;
  evaluate = extra: (import "${nixpkgs}/nixos/lib/eval-config.nix" {
    inherit system;
    modules = (if pruneModule != null then [ pruneModule ] else [
      ({ config, lib, pkgs, ... }: import ../nix/prune-service.nix { inherit config lib pkgs prunePackage pruneHostPackage; })
      ({ config, lib, pkgs, ... }: import ../nix/prune-selftest-service.nix { inherit config lib pkgs selftestPackage prunePackage; })
    ]) ++ [
      { system.stateVersion = "26.05"; }
      extra
    ];
  }).config;
  deployment = { name = "fixture"; disposableMount = "/disposable"; laptopHomeRoot = "/durable/employees";
    employeeIds = [ "11111111-1111-4111-8111-111111111111" ]; laptopUid = 1000; laptopGid = 1000; };
  off = evaluate { };
  on = evaluate { services.reverie.prune = { enable = true; inherit deployment; selftest = { enable = true; uid = 25001; gid = 25001; }; }; };
  bad = evaluate { services.reverie.prune = { enable = true; inherit deployment; selftest = { enable = true; uid = 1000; gid = 1000; }; }; };
  service = on.systemd.services.reverie-prune-selftest;
  setup = on.systemd.services.reverie-prune-selftest-prepare;
  s = service.serviceConfig;
  checks = {
    defaultOff = !off.services.reverie.prune.selftest.enable && !(off.systemd.services ? reverie-prune-selftest) && !(off.users.users ? reverie-prune-selftest);
    ownerDeclaredIds = on.users.users.reverie-prune-selftest.uid == 25001 && on.users.groups.reverie-prune-selftest.gid == 25001;
    realIdsRejected = builtins.any (entry: !entry.assertion) bad.assertions;
    privateIsolation = s.PrivateMounts && s.PrivateTmp && s.PrivateNetwork && s.ProtectHome && s.ProtectSystem == "strict";
    onlyFixtureAndReceiptWrites = s.ReadWritePaths == "\"/disposable/.reverie-prune-selftest\" \"/var/lib/reverie-prune-selftest\"";
    hostPidVisibility = !s.PrivateUsers && s.ProtectProc == "default" && s.ProcSubset == "all" && !(s ? RestrictNamespaces) && !(s ? CapabilityBoundingSet);
    fixedProtectedLease = lib.hasInfix "--lease-lib\" \"/var/lib/reverie-prune-selftest/lib/lease.py" s.ExecStart;
    fixedRawR12 = lib.hasInfix "fbed566fbdfe89d312abb8b1b32354e5f44f35b94918028ce882fbf444b17181" s.ExecStart;
    kitR2Exact = selftestPackage.sourceHashes."selftest.py" == "280dd66b9c83f0faa99c263dddbee99f8e37a1104548f4d4f690066d0061574e";
    noAutomaticStart = service.wantedBy == [ ] && setup.wantedBy == [ ];
    realLeasePrecedesSynthetic = builtins.elem "reverie-prune-lease-acceptance.service" service.requires && builtins.elem "reverie-prune-lease-acceptance.service" service.after;
    noTmpfilesAdoption = !(builtins.any (rule: lib.hasInfix "prune-selftest" rule) on.systemd.tmpfiles.rules);
    boundedLifecycle = s.KillMode == "control-group" && s.TimeoutStartSec == 900 && s.TasksMax == 128;
  };
in assert builtins.all (value: value) (builtins.attrValues checks); {
  inherit checks;
  serviceText = on.systemd.units."reverie-prune-selftest.service".text;
  prepareText = on.systemd.units."reverie-prune-selftest-prepare.service".text;
}
