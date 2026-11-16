# Separately pinned restore capability. Never replaces a deployed anchor image.
{ pkgs, src }:
let helper = import ./docker-resource-helper.nix { inherit pkgs src; };
in import ./docker-resource-helper-image.nix {
  inherit pkgs helper;
  poolRestore = true;
}
