{ pkgs, src, console, memoryNativeCli }:
let
  # Only this package's crate closure, so an unrelated change keeps its cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-contracts" "reverie-core" "reverie-diagnostics" "reverie-host" "reverie-http" "reverie-python-regex" "reverie-store" "reverie-mcp-cli" ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-mcp-cli";
  version = "0.1.0";
  src = workspace.source;
  # Top runtime owns both products. Console never depends back on this package.
  REVERIE_FIXED_MCP_NODE = "${pkgs.nodejs-slim_22}/bin/node";
  REVERIE_FIXED_MCP_ENTRY = "${console}/lib/reverie/dist/installed-mcp-entry.js";
  REVERIE_FIXED_MCP_MEMORY = "${memoryNativeCli}/bin/reverie-memory";
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-mcp-cli" ];
  cargoTestFlags = [ "-p" "reverie-mcp-cli" ];
  doCheck = true;
  meta = {
    description = "Fixed installed MCP candidate with per-use memory API policy checks";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
