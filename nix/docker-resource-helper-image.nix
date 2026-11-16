# No engine client, shell, network tool or writable host hierarchy is included.
{ pkgs, helper, memoryHighOnly ? false, poolRestore ? false, name ? (if memoryHighOnly then "reverie-boxed-memory-high-helper" else if poolRestore then "reverie-boxed-pool-restore-helper" else "reverie-boxed-resource-helper") }:
let
  # Image-only identity DATA: unlike Config labels, this is not inherited by
  # Docker CREATE and cannot change an original helper's configuration digest.
  identity = pkgs.writeText "reverie-helper-image-identity" (builtins.toJSON {
    version = 1;
    purpose = "reverie-helper-image-build-identity-v1";
    inherit name;
  });
in
pkgs.dockerTools.buildLayeredImage {
  inherit name;
  tag = "latest";
  contents = [];
  extraCommands = ''
    mkdir -p bin share/reverie
    cp ${helper}/bin/reverie-docker-resources bin/reverie-docker-resources
    chmod 0555 bin/reverie-docker-resources
    cp ${identity} share/reverie/helper-image-identity.json
    chmod 0444 share/reverie/helper-image-identity.json
  '';
  config = {
    User = "0:0";
    Entrypoint = [ "/bin/reverie-docker-resources" ];
    Cmd = [ "anchor" ];
    WorkingDir = "/";
    Labels = { "org.reverie.purpose" = "boxed-resource-helper-v1"; }
      // pkgs.lib.optionalAttrs memoryHighOnly { "org.reverie.resource.memory-high-only" = "v1"; }
      // pkgs.lib.optionalAttrs poolRestore { "org.reverie.resource.pool-restore" = "v1"; };
  };
}
