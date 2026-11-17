{ pkgs }:
let
  package = pkgs.tailscale.overrideAttrs (old: {
    patches = (old.patches or []) ++ [ ./patches/tailscale-serve-only.patch ];
  });
in {
  inherit package;
  install = ''
    mkdir -p usr/local/libexec/reverie-tailscale
    ln -s ${package}/bin/tailscale ${package}/bin/tailscaled usr/local/libexec/reverie-tailscale/
  '';
}
