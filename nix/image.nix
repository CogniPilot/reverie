{ pkgs, src, reverie, console, memory, runtime }:
let
  entrypoint = pkgs.writeShellScript "reverie-start" (builtins.readFile (src + "/docker/entrypoint.sh"));
in pkgs.dockerTools.buildLayeredImage {
  name = "reverie";
  tag = "latest";
  created = "1970-01-01T00:00:01Z";
  contents = [ runtime pkgs.dockerTools.binSh pkgs.dockerTools.usrBinEnv
    pkgs.dockerTools.caCertificates pkgs.sudo ];
  extraCommands = ''
    mkdir -p etc bin usr/local/bin opt/reverie home/agent workspace reverie_workspace scratch/tmp instances tmp
    unlink bin/reverie
    ln -s ${reverie}/bin/reverie bin/reverie
    ln -s ${reverie}/bin/reverie-request-update bin/reverie-request-update
    ln -s ${reverie}/bin/reverie-install-clis bin/reverie-install-clis
    printf 'root:x:0:0:root:/root:/bin/bash\nagent:x:2000:2000:Reverie:/home/agent:/bin/bash\n' > etc/passwd
    printf 'root:x:0:\nreverie:x:2000:\n' > etc/group
    printf 'root:!:1::::::\nagent:!:1::::::\n' > etc/shadow
    if [ -L etc/sudoers ]; then unlink etc/sudoers; fi
    printf 'root ALL=(ALL:ALL) ALL\nagent ALL=(ALL) NOPASSWD: ALL\n' > etc/sudoers
    printf 'hosts: files dns\npasswd: files\ngroup: files\n' > etc/nsswitch.conf
    mkdir -p etc/pam.d
    printf 'auth sufficient ${pkgs.linux-pam}/lib/security/pam_permit.so\naccount required ${pkgs.linux-pam}/lib/security/pam_permit.so\nsession required ${pkgs.linux-pam}/lib/security/pam_permit.so\n' > etc/pam.d/sudo
    ln -s ${console}/lib/reverie opt/reverie/console
    mkdir -p opt/reverie/apps
    ln -s ${console}/lib/reverie opt/reverie/apps/web
    ln -s ${memory} opt/reverie/python
    ln -s ${entrypoint} usr/local/bin/reverie-start
    chmod 1777 tmp
  '';
  fakeRootCommands = ''
    chown -R 2000:2000 home/agent workspace reverie_workspace scratch instances
    chgrp -R 0 home/agent scratch
    chmod 2770 home/agent scratch scratch/tmp
    chmod 0440 etc/sudoers
    chmod 0600 etc/shadow
    # sudo must be a real setuid file, not a Nix store symlink.
    rm bin/sudo
    cp ${pkgs.sudo}/bin/sudo bin/sudo
    chown 0:0 bin/sudo
    chmod 4755 bin/sudo
  '';
  enableFakechroot = true;
  config = {
    User = "2000:2000";
    WorkingDir = "/reverie_workspace";
    Entrypoint = [ "/usr/local/bin/reverie-start" ];
    Cmd = [ "reverie" "web" "--host" "0.0.0.0" "--port" "3000" ];
    Env = [ "PATH=/bin" "HOME=/home/agent" "REVERIE_CONTAINER=1" "REVERIE_MANAGED_INSTALL=nix"
      "REVERIE_VERSION=${console.version}" "REVERIE_CASES_PATH=/scratch/cases"
      "REVERIE_RESEARCH_ROOT=/scratch/research" "TMPDIR=/scratch/tmp"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt"
      "NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt" ];
    ExposedPorts."3000/tcp" = { };
    Labels."org.opencontainers.image.source" = "https://github.com/jgoppert/reverie";
  };
}
