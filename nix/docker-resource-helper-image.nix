# No engine client, shell, network tool or writable host hierarchy is included.
{ pkgs, helper, memoryHighOnly ? false, name ? (if memoryHighOnly then "reverie-boxed-memory-high-helper" else "reverie-boxed-resource-helper") }:
pkgs.dockerTools.buildLayeredImage {
  inherit name;
  tag = "latest";
  contents = [];
  extraCommands = ''
    mkdir -p bin
    cp ${helper}/bin/reverie-docker-resources bin/reverie-docker-resources
    chmod 0555 bin/reverie-docker-resources
  '';
  config = {
    User = "0:0";
    Entrypoint = [ "/bin/reverie-docker-resources" ];
    Cmd = [ "anchor" ];
    WorkingDir = "/";
    Labels = { "org.reverie.purpose" = "boxed-resource-helper-v1"; }
      // pkgs.lib.optionalAttrs memoryHighOnly { "org.reverie.resource.memory-high-only" = "v1"; };
  };
}
