# Image contents are immutable; all runtime mounts and limits are supplied by
# the fixed native bootstrap and independently checked by the controller.
{ pkgs, controller }:
pkgs.dockerTools.buildLayeredImage {
  name = "reverie-worker-resource-controller";
  tag = "native-v2";
  contents = [ controller ];
  config = {
    Entrypoint = [ "/bin/reverie-worker-resource-controller" ];
    Env = [ "PATH=/bin" "LANG=C.UTF-8" ];
    User = "0:0";
    WorkingDir = "/";
  };
}
