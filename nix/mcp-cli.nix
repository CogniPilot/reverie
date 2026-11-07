{ pkgs, src, console, memoryNativeCli }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-mcp-cli";
  version = "0.1.0";
  inherit src;
  # Top runtime owns both products. Console never depends back on this package.
  REVERIE_FIXED_MCP_NODE = "${pkgs.nodejs-slim_22}/bin/node";
  REVERIE_FIXED_MCP_ENTRY = "${console}/lib/reverie/dist/installed-mcp-entry.js";
  REVERIE_FIXED_MCP_MEMORY = "${memoryNativeCli}/bin/reverie-memory";
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-mcp-cli" ];
  cargoTestFlags = [ "-p" "reverie-mcp-cli" ];
  doCheck = true;
  meta = {
    description = "Fixed installed MCP candidate with per-use memory API policy checks";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
