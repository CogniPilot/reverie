# Optional host account for a reverie deployment. Container sudo stays inside containers.
{ config, lib, pkgs, ... }:
let cfg = config.services.reverie;
in {
  options.services.reverie = {
    enable = lib.mkEnableOption "a separate rootless Reverie account";
    userName = lib.mkOption { type = lib.types.str; default = "reverie"; };
    home = lib.mkOption { type = lib.types.path; default = "/var/lib/reverie"; };
  };
  config = lib.mkIf cfg.enable {
    users.groups.${cfg.userName} = {};
    users.users.${cfg.userName} = {
      isNormalUser = true;
      group = cfg.userName;
      home = cfg.home;
      homeMode = "700";
      createHome = true;
      linger = true;
      # No wheel, docker, shared credentials or host sudo grant.
      extraGroups = [];
      packages = with pkgs; [ git tmux python3 nodejs podman ];
    };
    virtualisation.podman = { enable = true; dockerCompat = false; dockerSocket.enable = false; };
    systemd.tmpfiles.rules = [
      "d ${cfg.home}/reverie 0700 ${cfg.userName} ${cfg.userName} -"
      "d ${cfg.home}/projects 0700 ${cfg.userName} ${cfg.userName} -"
    ];
  };
}
