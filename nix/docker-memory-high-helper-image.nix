# Independent immutable writer selection. Never replace a deployed baseline helper pin.
{ pkgs, src }:
let helper = import ./docker-resource-helper.nix { inherit pkgs src; };
in import ./docker-resource-helper-image.nix {
  inherit pkgs helper;
  memoryHighOnly = true;
}
