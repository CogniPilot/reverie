{ pkgs, src, reverie, console, memory, runtime, worker ? false, browserRuntime ? null, chatLanguageTools ? null, rootlessDocker ? null }:
let
  uid = if rootlessDocker == null then 2000 else rootlessDocker.uid;
  gid = if rootlessDocker == null then 2000 else rootlessDocker.gid;
  idmap = import ./worker-idmap.nix { inherit pkgs; };
  entrypoint = pkgs.writeShellScript "reverie-start" (builtins.readFile (src + "/docker/entrypoint.sh"));
  nixPrepare = pkgs.writeShellApplication {
    name = "reverie-nix-store-prepare";
    runtimeInputs = [ pkgs.nix pkgs.coreutils ];
    text = pkgs.lib.removePrefix "#!/usr/bin/env bash\n" (builtins.readFile (src + "/scripts/reverie-nix-store-prepare"));
  };
  baseContents = [ runtime pkgs.dockerTools.binSh pkgs.dockerTools.usrBinEnv
    pkgs.dockerTools.caCertificates pkgs.sudo pkgs.tini ]
    ++ pkgs.lib.optionals worker [ pkgs.nix nixPrepare ]
    ++ pkgs.lib.optional (rootlessDocker != null) idmap
    ++ pkgs.lib.optional (browserRuntime != null) browserRuntime
    ++ pkgs.lib.optionals (chatLanguageTools != null) [ chatLanguageTools.python chatLanguageTools.modelica ];
  nixBase = pkgs.linkFarm "reverie-laptop-base" (pkgs.lib.imap0 (i: path: {
    name = "share/reverie/base/${toString i}"; inherit path;
  }) (baseContents ++ [ reverie console memory entrypoint ]));
  nixClosure = pkgs.closureInfo { rootPaths = [ nixBase ]; };
  nixpkgsPin = (builtins.fromJSON (builtins.readFile (src + "/flake.lock"))).nodes.nixpkgs.locked;
in assert rootlessDocker == null || (worker && builtins.isInt uid && builtins.isInt gid && uid > 0 && gid > 0
  && uid < 2147483648 && gid < 2147483648
  && builtins.isInt rootlessDocker.subuidStart && rootlessDocker.subuidStart > 0
  && builtins.isInt rootlessDocker.subgidStart && rootlessDocker.subgidStart > 0
  && builtins.isInt rootlessDocker.subidCount && rootlessDocker.subidCount >= 65536
  && rootlessDocker.subuidStart + rootlessDocker.subidCount < 4294967295
  && rootlessDocker.subgidStart + rootlessDocker.subidCount < 4294967295
  && !(uid >= rootlessDocker.subuidStart && uid < rootlessDocker.subuidStart + rootlessDocker.subidCount)
  && !(gid >= rootlessDocker.subgidStart && gid < rootlessDocker.subgidStart + rootlessDocker.subidCount));
pkgs.dockerTools.buildLayeredImage {
  name = if browserRuntime != null then "reverie-worker-browser" else if worker then "reverie-worker" else "reverie";
  tag = "latest";
  created = "1970-01-01T00:00:01Z";
  contents = baseContents ++ pkgs.lib.optional worker nixBase;
  extraCommands = ''
    mkdir -p etc bin usr/local/bin opt/reverie home/agent workspace reverie_workspace scratch/tmp instances tmp
    unlink bin/reverie
    ln -s ${reverie}/bin/reverie bin/reverie
    ln -s ${reverie}/bin/reverie-request-update bin/reverie-request-update
    ln -s ${reverie}/bin/reverie-install-clis bin/reverie-install-clis
    printf 'root:x:0:0:root:/root:/bin/bash\nagent:x:${toString uid}:${toString gid}:Reverie:/home/agent:/bin/bash\n' > etc/passwd
    printf 'root:x:0:\nreverie:x:${toString gid}:\n' > etc/group
    printf 'root:!:1::::::\nagent:!:1::::::\n' > etc/shadow
    if [ -L etc/sudoers ]; then unlink etc/sudoers; fi
    printf 'root ALL=(ALL:ALL) ALL\nagent ALL=(ALL) NOPASSWD: ALL\n' > etc/sudoers
    printf 'hosts: files dns\npasswd: files\ngroup: files\n' > etc/nsswitch.conf
    ${pkgs.lib.optionalString (rootlessDocker != null) ''
      printf 'agent:${toString rootlessDocker.subuidStart}:${toString rootlessDocker.subidCount}\n' > etc/subuid
      printf 'agent:${toString rootlessDocker.subgidStart}:${toString rootlessDocker.subidCount}\n' > etc/subgid
      rm -rf opt/reverie-idmap
      cp -a ${idmap}/opt/reverie-idmap opt/
      test -z "$(find opt/reverie-idmap -type l -print)"
      ln -s /opt/reverie-idmap/bin/newuidmap bin/newuidmap
      ln -s /opt/reverie-idmap/bin/newgidmap bin/newgidmap
      printf 'root ALL=(ALL:ALL) ALL\n' > etc/sudoers
    ''}
    mkdir -p etc/pam.d
    printf 'auth sufficient ${pkgs.linux-pam}/lib/security/pam_permit.so\naccount required ${pkgs.linux-pam}/lib/security/pam_permit.so\nsession required ${pkgs.linux-pam}/lib/security/pam_permit.so\n' > etc/pam.d/sudo
    ln -s ${console}/lib/reverie opt/reverie/console
    mkdir -p opt/reverie/apps
    ln -s ${console}/lib/reverie opt/reverie/apps/web
    ln -s ${memory} opt/reverie/python
    ln -s ${entrypoint} usr/local/bin/reverie-start
    chmod 1777 tmp
  '' + pkgs.lib.optionalString worker ''
    mkdir -p etc/nix nix/store/.links target/nix
    cp ${nixClosure}/registration etc/reverie-nix-registration
    ln -s ${nixBase} etc/reverie-nix-base
    cat > etc/nix/nix.conf <<'NIXCONF'
    experimental-features = nix-command flakes
    build-users-group =
    sandbox = false
    max-jobs = 1
    cores = 4
    flake-registry = /etc/nix/registry.json
    NIXCONF
    cat > etc/nix/registry.json <<'REGISTRY'
    ${builtins.toJSON { version = 2; flakes = [{ from = { type = "indirect"; id = "nixpkgs"; }; to = nixpkgsPin; }]; }}
    REGISTRY
  '';
  fakeRootCommands = ''
    chown -R ${toString uid}:${toString gid} home/agent workspace reverie_workspace scratch instances
    chgrp -R 0 home/agent scratch
    chmod 2770 home/agent scratch scratch/tmp
    chmod 0440 etc/sudoers
    chmod 0600 etc/shadow
    # sudo must be a real setuid file, not a Nix store symlink.
    rm bin/sudo
    ${if rootlessDocker == null then ''
      cp ${pkgs.sudo}/bin/sudo bin/sudo
      chown 0:0 bin/sudo
      chmod 4755 bin/sudo
    '' else ''
      chown -R 0:0 opt/reverie-idmap
      chmod -R go-w opt/reverie-idmap
      ${pkgs.libcap}/bin/setcap cap_setuid=ep opt/reverie-idmap/bin/newuidmap
      ${pkgs.libcap}/bin/setcap cap_setgid=ep opt/reverie-idmap/bin/newgidmap
      export TAR_OPTIONS="--xattrs --xattrs-include=security.capability"
    ''}
  '';
  enableFakechroot = true;
  config = {
    User = "${toString uid}:${toString gid}";
    WorkingDir = "/reverie_workspace";
    Entrypoint = if worker then [ "/bin/sleep" ] else [ "/bin/tini" "-g" "-s" "--" "/usr/local/bin/reverie-start" ];
    Cmd = if worker then [ "infinity" ] else [ "reverie" "web" "--host" "0.0.0.0" "--port" "3000" ];
    Env = [ (if worker then "PATH=/home/agent/.nix-profile/bin:/home/agent/.local/bin:/home/agent/.local/state/nix/profiles/profile/bin:/bin" else "PATH=/bin")
      "HOME=/home/agent" "REVERIE_CONTAINER=1" "REVERIE_MANAGED_INSTALL=nix"
      "REVERIE_VERSION=${console.version}"
      "REVERIE_CASES_PATH=${if worker then "/home/agent/.local/share/reverie/cases" else "/scratch/cases"}"
      "REVERIE_SHARED_WORKSPACE_PATH=/reverie_workspace"
      "REVERIE_SHARED_ATTACHMENTS_PATH=/reverie_workspace/attachments"
      "REVERIE_RESEARCH_ROOT=${if worker then "/home/agent/.local/share/reverie/research" else "/scratch/research"}"
      "TMPDIR=${if worker then "/tmp" else "/scratch/tmp"}"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
      "NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt" ]
      ++ pkgs.lib.optionals worker [ "NIX_REMOTE=local" "NIX_PATH=nixpkgs=flake:nixpkgs" ]
      ++ pkgs.lib.optionals (chatLanguageTools != null) [
        "REVERIE_CHAT_PYTHON_LSP_BINARY=${chatLanguageTools.python}/bin/pyright-langserver"
        "REVERIE_CHAT_MODELICA_LSP_BINARY=${chatLanguageTools.modelica}/bin/rumoca-lsp"
      ];
    ExposedPorts."3000/tcp" = { };
    Labels = {
      "org.opencontainers.image.source" = "https://github.com/jgoppert/reverie";
      "reverie.worker.nix-store" = if worker then "1" else "0";
      "org.reverie.worker.uid" = toString uid;
      "org.reverie.worker.gid" = toString gid;
      "org.reverie.worker.rootless-docker" = if rootlessDocker == null then "0" else "1";
    } // pkgs.lib.optionalAttrs (rootlessDocker != null) {
      "org.reverie.worker.subuid-start" = toString rootlessDocker.subuidStart;
      "org.reverie.worker.subgid-start" = toString rootlessDocker.subgidStart;
      "org.reverie.worker.subid-count" = toString rootlessDocker.subidCount;
    };
  };
}
