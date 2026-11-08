{ pkgs, src }:
# reverie-lease from the shared build in host-tools.nix, which compiles reverie-host once for several tools.
let
  tools = import ./host-tools.nix { inherit pkgs src; };
in
pkgs.runCommand "reverie-lease-0.1.0" {
  meta = {
    description = "Native lease command for disposable work directories";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
    mainProgram = "reverie-lease";
  };
} ''
  mkdir -p "$out/bin"
  ln -s ${tools}/bin/reverie-lease "$out/bin/reverie-lease"
''
