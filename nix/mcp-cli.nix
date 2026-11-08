{ pkgs, src, console, memoryNativeCli }:
# reverie-mcp from the shared build in host-console-tools.nix, which compiles reverie-host once for several tools.
# memoryNativeCli stays accepted for callers: the memory binary reverie-mcp runs now comes from that same build.
let
  tools = import ./host-console-tools.nix { inherit pkgs src console; };
in
pkgs.runCommand "reverie-mcp-cli-0.1.0" {
  meta = {
    description = "Fixed installed MCP candidate with per-use memory API policy checks";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
} ''
  mkdir -p "$out/bin"
  ln -s ${tools}/bin/reverie-mcp "$out/bin/reverie-mcp"
''
