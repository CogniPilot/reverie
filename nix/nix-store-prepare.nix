{ pkgs, src }:
# reverie-nix-store-prepare from the shared build in host-tools.nix, which compiles reverie-host once for several tools.
let
  tools = import ./host-tools.nix { inherit pkgs src; };
in
pkgs.runCommand "reverie-nix-store-prepare-0.1.0" {
  meta = {
    description = "Fixed unprivileged guest bootstrap for a worker private Nix store";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
} ''
  mkdir -p "$out/bin"
  ln -s ${tools}/bin/reverie-nix-store-prepare "$out/bin/reverie-nix-store-prepare"
''
