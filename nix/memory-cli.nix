{ pkgs, src, console }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-memory-cli";
  version = "0.1.0";
  inherit src;
  # nodejs_22/bin/node is a symlink to this canonical ELF, not a wrapper.
  REVERIE_FIXED_JOURNAL_NODE = "${pkgs.nodejs-slim_22}/bin/node";
  REVERIE_FIXED_JOURNAL_ENTRY = "${console}/lib/reverie/dist/index.js";
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-memory-cli" ];
  cargoTestFlags = [ "-p" "reverie-memory-cli" ];
  nativeCheckInputs = [ pkgs.coreutils ];
  doCheck = true;
  meta = {
    description = "Native explicitly scoped memory and authenticated journal bridge candidate";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
