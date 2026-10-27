# Synthetic phase-3 acceptance. This does not replace real laptop H1-H4 checks.
{ config, lib, pkgs, selftestPackage, prunePackage }:
let
  p = config.services.reverie.prune;
  cfg = p.selftest;
  d = p.deployment;
  base = "${d.disposableMount}/${cfg.fixtureName}";
  state = cfg.stateDirectory;
  quoted = value: builtins.replaceStrings [ "%" "$" ] [ "%%" "$$" ] (builtins.toJSON (toString value));
  argv = lib.concatMapStringsSep " " quoted;
  pathQuoted = value: builtins.replaceStrings [ "%" ] [ "%%" ] (builtins.toJSON value);
  within = parent: child: child == parent || lib.hasPrefix "${parent}/" child;
  settings = pkgs.writeText "reverie-prune-selftest.json" (builtins.toJSON {
    version = 1; b_mount = d.disposableMount; laptops_root = d.laptopsRoot;
    laptop_uid = d.laptopUid; laptop_gid = d.laptopGid;
    uid = cfg.uid; gid = cfg.gid; inherit base state; live_state = p.stateDirectory;
  });
  kit = "${selftestPackage}/libexec/reverie/selftest";
in {
  options.services.reverie.prune.selftest = {
    enable = lib.mkEnableOption "the reviewed synthetic phase-3 acceptance units (no automatic start)";
    uid = lib.mkOption { type = lib.types.ints.positive; description = "Owner-selected free UID dedicated to synthetic fixtures; must differ from laptopUid."; };
    gid = lib.mkOption { type = lib.types.ints.positive; description = "Owner-selected free GID dedicated to synthetic fixtures; must differ from laptopGid."; };
    fixtureName = lib.mkOption { type = lib.types.strMatching "[A-Za-z0-9._-]+"; default = ".reverie-prune-selftest"; };
    stateDirectory = lib.mkOption { type = lib.types.strMatching "/[A-Za-z0-9._/-]+"; default = "/var/lib/reverie-prune-selftest";
      description = "Dedicated protected receipt/code-copy state outside production state and the disposable filesystem."; };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = p.enable; message = "Reverie phase-3 selftest requires the declared cleanup module."; }
      { assertion = cfg.uid != d.laptopUid && cfg.gid != d.laptopGid; message = "Synthetic fixture UID/GID must differ from real laptops."; }
      { assertion = cfg.fixtureName != "." && cfg.fixtureName != ".."; message = "Dedicated selftest fixture name required."; }
      { assertion = builtins.match "/[A-Za-z0-9._/-]+" d.disposableMount != null; message = "The reviewed selftest runner requires plain absolute filesystem paths."; }
      { assertion = state != p.stateDirectory && !(lib.hasPrefix "${p.stateDirectory}/" state) && !(lib.hasPrefix "${state}/" p.stateDirectory);
        message = "Selftest receipts must remain separate from production cleanup state."; }
      { assertion = !(within d.disposableMount state) && !(within "${d.disposableMount}/${d.laptopsRoot}" base) && !(within base "${d.disposableMount}/${d.laptopsRoot}");
        message = "Selftest fixture and receipts must remain outside real laptop roots and disposable receipt storage."; }
      { assertion = builtins.all (path: !(builtins.any (home: within home path) [ "/home" "/root" "/run/user" ])) [ base state ];
        message = "Selftest paths must be outside the homes hidden by ProtectHome=true."; }
    ];
    users.groups.reverie-prune-selftest.gid = cfg.gid;
    users.users.reverie-prune-selftest = {
      isSystemUser = true; uid = cfg.uid; group = "reverie-prune-selftest";
      createHome = false; description = "Synthetic cleanup acceptance fixtures";
    };
    systemd.services.reverie-prune-selftest-prepare = {
      description = "Prepare root custody for isolated cleanup acceptance";
      restartIfChanged = false; stopIfChanged = false;
      unitConfig.RequiresMountsFor = pathQuoted d.disposableMount;
      serviceConfig = {
        Type = "oneshot"; User = "root"; Group = "root"; UMask = "0077";
        # Fixed initializer needs the actual host mount view before sandboxing.
        ExecStart = argv [ "${selftestPackage}/bin/reverie-prune-selftest-prepare" "--config" settings ];
        NoNewPrivileges = true; TimeoutStartSec = 30; MemoryMax = "256M"; TasksMax = 16;
      };
    };
    systemd.services.reverie-prune-selftest = {
      description = "Isolated synthetic cleanup phase-3 selftest (r2)";
      requires = [ "reverie-prune-selftest-prepare.service" "reverie-prune-lease-acceptance.service" ];
      after = [ "reverie-prune-selftest-prepare.service" "reverie-prune-lease-acceptance.service" ];
      restartIfChanged = false; stopIfChanged = false;
      path = [ pkgs.bash pkgs.coreutils pkgs.util-linux pkgs.gawk pkgs.git ];
      serviceConfig = {
        Type = "oneshot"; User = "root"; Group = "root"; UMask = "0077";
        ExecStart = argv [ "${pkgs.python3}/bin/python3" "-I" "-B" "${kit}/selftest.py"
          "--base" base "--uid" cfg.uid "--gid" cfg.gid "--python" "${pkgs.python3}/bin/python3"
          "--prune" "${prunePackage}/libexec/reverie/reverie_prune.py"
          "--prune-sha" "fbed566fbdfe89d312abb8b1b32354e5f44f35b94918028ce882fbf444b17181"
          "--lease-lib" "${state}/lib/lease.py"
          "--lease-sha" "7b640a38331c198626601346594ead1437fd6c15044393e55996aee9b62337f9"
          "--runner" "${kit}/p3_host_runner.sh" "--kit" kit "--receipt" "${state}/selftest-receipt.json" ];
        PrivateMounts = true; PrivateTmp = true; PrivateNetwork = true; ProtectHome = true;
        NoNewPrivileges = true; PrivateUsers = false; ProtectProc = "default"; ProcSubset = "all";
        ProtectSystem = "strict";
        ReadWritePaths = lib.concatMapStringsSep " " pathQuoted [ base state ];
        RuntimeDirectory = "reverie-prune-selftest"; RuntimeDirectoryMode = "0700";
        KillMode = "control-group"; TimeoutStartSec = 900; MemoryMax = "1G"; TasksMax = 128;
      };
    };
  };
}
