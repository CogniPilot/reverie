{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-core" "reverie-contracts" "reverie-store" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-recovery-ledger";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-store" "--bin" "reverie-recovery-ledger" ];
  cargoTestFlags = [ "-p" "reverie-store" "--lib" "--test" "recovery_ledger_rpc" "recovery_ledger" ];
  doCheck = true;
  meta = {
    description = "Bounded stdio adapter for the private SQLite recovery ledger";
    mainProgram = "reverie-recovery-ledger";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
