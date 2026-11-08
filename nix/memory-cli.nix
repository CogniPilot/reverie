{ pkgs, src, console }:
# reverie-memory from the shared build in host-console-tools.nix, which compiles reverie-host once for several tools.
let
  tools = import ./host-console-tools.nix { inherit pkgs src console; };
in
pkgs.runCommand "reverie-memory-cli-0.1.0" {
  meta = {
    description = "Native explicitly scoped memory and authenticated journal bridge candidate";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
} ''
  mkdir -p "$out/bin"
  ln -s ${tools}/bin/reverie-memory "$out/bin/reverie-memory"
  ln -s ${tools}/share "$out/share"
''
