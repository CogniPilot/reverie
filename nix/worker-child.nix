{ pkgs, src }:
# reverie-worker-child from the shared build in host-tools.nix, which compiles reverie-host once for several tools.
let
  tools = import ./host-tools.nix { inherit pkgs src; };
in
pkgs.runCommand "reverie-worker-child-0.1.0" {
  meta = {
    description = "Fixed-purpose native in-worker launch record and pane lifecycle";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
} ''
  mkdir -p "$out/bin"
  ln -s ${tools}/bin/reverie-worker-child "$out/bin/reverie-worker-child"
''
