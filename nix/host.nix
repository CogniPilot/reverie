# Optional host account for a fleet deployment. Container sudo stays inside containers.
{ config, lib, pkgs, ... }:
let cfg = config.services.agentFleet;
in {
  options.services.agentFleet = {
    enable = lib.mkEnableOption "a separate rootless agent fleet account";
    userName = lib.mkOption { type = lib.types.str; default = "fleet"; };
    home = lib.mkOption { type = lib.types.path; default = "/var/lib/agent-fleet"; };
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
      "d ${cfg.home}/.local/share/agent-fleet 0700 ${cfg.userName} ${cfg.userName} -"
      "d ${cfg.home}/projects 0700 ${cfg.userName} ${cfg.userName} -"
    ];
  };
}
