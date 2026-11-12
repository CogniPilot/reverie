# Fixed inert anchor contents only. The native pool owner supplies the actual
# identity, confinement and limits; this archive grants no installation authority.
{ pkgs }:
pkgs.dockerTools.buildLayeredImage {
  name = "reverie-worker-pool-anchor";
  tag = "native-v1";
  created = "1970-01-01T00:00:01Z";
  contents = [ pkgs.coreutils ];
  config = {
    Entrypoint = [ "/bin/sleep" ];
    Cmd = [ "infinity" ];
    Env = [ "PATH=/bin" "LANG=C.UTF-8" ];
    User = "0:0";
    WorkingDir = "/";
  };
}
