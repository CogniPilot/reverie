{ pkgs, src, reverie, console, memory, runtime, worker ? false, browserRuntime ? null, chatLanguageTools ? null, rootlessDocker ? null, resourceReplacement ? false, ownerTerminalWebsite ? null }:
let
  uid = if rootlessDocker == null then 2000 else rootlessDocker.uid;
  gid = if rootlessDocker == null then 2000 else rootlessDocker.gid;
  idmap = import ./worker-idmap.nix { inherit pkgs; };
  # Kernel-start the untouched Claude/Bun ELF so /proc/self/exe names Claude,
  # not ld-linux (its bundled grep/find shims use process.execPath).
  claudeInterpreter = if pkgs.stdenv.hostPlatform.isx86_64 then "/lib64/ld-linux-x86-64.so.2"
    else if pkgs.stdenv.hostPlatform.isAarch64 then "/lib/ld-linux-aarch64.so.1"
    else null;
  entrypoint = pkgs.writeShellScript "reverie-start" (builtins.readFile (src + "/docker/entrypoint.sh"));
  humanToolkit = import ./human-terminal-toolkit.nix { inherit pkgs src; };
  nixPrepare = pkgs.writeShellApplication {
    name = "reverie-nix-store-prepare";
    runtimeInputs = [ pkgs.nix pkgs.coreutils ];
    text = pkgs.lib.removePrefix "#!/usr/bin/env bash\n" (builtins.readFile (src + "/scripts/reverie-nix-store-prepare"));
  };
  # dockerTools.caCertificates, but from the runtime's CA bundle rather than the pinned nixpkgs' older one.
  caCertificates = pkgs.runCommand "ca-certificates" { } ''
    mkdir -p $out/etc/ssl/certs $out/etc/pki/tls/certs
    ln -s ${runtime.cacert}/etc/ssl/certs/ca-bundle.crt $out/etc/ssl/certs/ca-bundle.crt
    ln -s ${runtime.cacert}/etc/ssl/certs/ca-bundle.crt $out/etc/ssl/certs/ca-certificates.crt
    ln -s ${runtime.cacert}/etc/ssl/certs/ca-bundle.crt $out/etc/pki/tls/certs/ca-bundle.crt
  '';
  baseContents = [ runtime pkgs.dockerTools.binSh pkgs.dockerTools.usrBinEnv
    caCertificates pkgs.sudo pkgs.tini ]
    ++ pkgs.lib.optionals worker ([ pkgs.nix nixPrepare ]
      ++ import ./worker-base-tools.nix { inherit pkgs; })
    ++ pkgs.lib.optional (rootlessDocker != null) idmap
    ++ pkgs.lib.optional (browserRuntime != null) browserRuntime
    ++ pkgs.lib.optionals (chatLanguageTools != null) [ chatLanguageTools.python chatLanguageTools.modelica ];
  nixBase = pkgs.linkFarm "reverie-laptop-base" (pkgs.lib.imap0 (i: path: {
    name = "share/reverie/base/${toString i}"; inherit path;
  }) (baseContents ++ [ reverie console memory entrypoint ]));
  nixClosure = pkgs.closureInfo { rootPaths = [ nixBase ]; };
  nixpkgsPin = (builtins.fromJSON (builtins.readFile (src + "/flake.lock"))).nodes.nixpkgs.locked;
in assert builtins.isBool resourceReplacement && (!resourceReplacement || !worker);
assert ownerTerminalWebsite == null || (!worker && !resourceReplacement && builtins.elem ownerTerminalWebsite.webArgs [
  [ "web" "--host" "0.0.0.0" "--port" "3000" ]
  [ "web" "--host" "0.0.0.0" "--port" "3000" "--resource-replacement" ]
]);
assert rootlessDocker == null || (worker && builtins.isInt uid && builtins.isInt gid && uid > 0 && gid > 0
  && uid < 2147483648 && gid < 2147483648
  && builtins.isInt rootlessDocker.subuidStart && rootlessDocker.subuidStart > 0
  && builtins.isInt rootlessDocker.subgidStart && rootlessDocker.subgidStart > 0
  && builtins.isInt rootlessDocker.subidCount && rootlessDocker.subidCount >= 65536
  && rootlessDocker.subuidStart + rootlessDocker.subidCount < 4294967295
  && rootlessDocker.subgidStart + rootlessDocker.subidCount < 4294967295
  && !(uid >= rootlessDocker.subuidStart && uid < rootlessDocker.subuidStart + rootlessDocker.subidCount)
  && !(gid >= rootlessDocker.subgidStart && gid < rootlessDocker.subgidStart + rootlessDocker.subidCount));
pkgs.dockerTools.buildLayeredImage {
  name = if browserRuntime != null then "reverie-worker-browser" else if worker then "reverie-worker" else if ownerTerminalWebsite != null then "reverie-owner-terminal" else "reverie";
  tag = "latest";
  created = "1970-01-01T00:00:01Z";
  contents = baseContents ++ pkgs.lib.optional worker nixBase
    ++ pkgs.lib.optional (ownerTerminalWebsite != null) ownerTerminalWebsite;
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
      # Static mount slots and account parents must never alias writable Nix or
      # user data. Fail the image build if any future contents populate them.
      mkdir -p nix
      for directory in home nix opt scratch scratch/tmp; do
        test -d "$directory" && test ! -L "$directory"
      done
      # sudo supplies this conventional relative link. Give the container init
      # its own directory while retaining the normal tools under /bin.
      if [ -L sbin ]; then
        test "$(readlink sbin)" = bin
        unlink sbin
      fi
      for directory in projects host-published workspace reverie_workspace instances run tmp sbin home/agent; do
        if [ -e "$directory" ] || [ -L "$directory" ]; then
          test -d "$directory" && test ! -L "$directory"
          test -z "$(find "$directory" -mindepth 1 -print -quit)"
        else
          mkdir "$directory"
        fi
      done
      mkdir -p instances/default/accounts instances/default/console/accounts instances/default/tools
      for directory in instances/default instances/default/accounts instances/default/console instances/default/console/accounts instances/default/tools; do
        test -d "$directory" && test ! -L "$directory"
      done
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
    ${pkgs.lib.optionalString (worker && claudeInterpreter != null) ''
      mkdir -p .${builtins.dirOf claudeInterpreter}
      # Never cover a future image's existing interpreter or dangling link.
      test ! -e .${claudeInterpreter} && test ! -L .${claudeInterpreter}
      ln -s ${pkgs.stdenv.cc.bintools.dynamicLinker} .${claudeInterpreter}
    ''}
    ${pkgs.lib.optionalString worker ''
      mkdir -p opt/reverie/human/bin
      # Direct image-root files, not links into the laptop's writable /nix.
      cp ${humanToolkit}/opt/reverie/human/bin/{reverie-human-shell,bash} opt/reverie/human/bin/
      chmod 555 opt/reverie/human/bin/{reverie-human-shell,bash}
      mkdir -p opt/reverie/autoenv/bin opt/reverie/autoenv/lib
      cp ${src}/scripts/reverie-autoenv-shim opt/reverie/autoenv/lib/shim
      cp ${src}/scripts/reverie-autoenv bin/reverie-autoenv
      cp ${src}/scripts/reverie-cargo-defaults bin/reverie-cargo-defaults
      cp ${src}/scripts/reverie-build-jobs bin/reverie-build-jobs
      sed -i '1c#!${memory}/bin/python3' bin/reverie-autoenv bin/reverie-cargo-defaults bin/reverie-build-jobs
      sed -i '1c#!${pkgs.bash}/bin/bash' opt/reverie/autoenv/lib/shim
      chmod 755 bin/reverie-autoenv bin/reverie-cargo-defaults bin/reverie-build-jobs opt/reverie/autoenv/lib/shim
      for tool in cargo rustc rustdoc pkg-config; do
        ln -s /opt/reverie/autoenv/lib/shim opt/reverie/autoenv/bin/$tool
      done
    ''}
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
    mkdir -p instances/default
    chown -R ${toString uid}:${toString gid} home/agent workspace reverie_workspace scratch instances
    # Keep the shared mount parent protected when a deployment selects another
    # runtime UID. The default instance remains writable by the image user.
    chown 0:0 instances
    chmod 0755 instances
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
    Cmd = if worker then [ "infinity" ] else if ownerTerminalWebsite != null then
      ([ "${ownerTerminalWebsite}/libexec/reverie" ] ++ ownerTerminalWebsite.webArgs) else
      [ "reverie" "web" "--host" "0.0.0.0" "--port" "3000" ]
      ++ pkgs.lib.optionals resourceReplacement [ "--resource-replacement" ];
    Env = [ (if worker then "PATH=/opt/reverie/autoenv/bin:/home/agent/.nix-profile/bin:/home/agent/.local/bin:/home/agent/.local/state/nix/profiles/profile/bin:/bin" else "PATH=/bin")
      "HOME=/home/agent" "REVERIE_CONTAINER=1" "REVERIE_MANAGED_INSTALL=nix"
      "REVERIE_VERSION=${console.version}"
      "REVERIE_CASES_PATH=${if worker then "/home/agent/.local/share/reverie/cases" else "/scratch/cases"}"
      "REVERIE_SHARED_WORKSPACE_PATH=/reverie_workspace"
      "REVERIE_SHARED_ATTACHMENTS_PATH=/reverie_workspace/attachments"
      "REVERIE_RESEARCH_ROOT=${if worker then "/home/agent/.local/share/reverie/research" else "/scratch/research"}"
      "TMPDIR=${if worker then "/tmp" else "/scratch/tmp"}"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
      "NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt" ]
      ++ pkgs.lib.optionals worker [ "NIX_REMOTE=local" "NIX_PATH=nixpkgs=flake:nixpkgs"
        "TZDIR=${pkgs.tzdata}/share/zoneinfo" ]
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
    } // pkgs.lib.optionalAttrs (!worker && (resourceReplacement || ownerTerminalWebsite != null)) {
      "org.reverie.website.runtime" = if ownerTerminalWebsite == null then "resource"
        else if builtins.elem "--resource-replacement" ownerTerminalWebsite.webArgs then "resource-terminal"
        else "terminal";
    } // pkgs.lib.optionalAttrs (browserRuntime != null) {
      "org.reverie.worker.browser" = "1";
    } // pkgs.lib.optionalAttrs (rootlessDocker != null) {
      "org.reverie.worker.subuid-start" = toString rootlessDocker.subuidStart;
      "org.reverie.worker.subgid-start" = toString rootlessDocker.subgidStart;
      "org.reverie.worker.subid-count" = toString rootlessDocker.subidCount;
      "org.reverie.worker.rootless-docker.mount-layout" = "1";
    };
  };
}
