{ pkgs, src }:
let workspace = import ./rust-workspace-source.nix {
  inherit pkgs src;
  members = [ "reverie-worker-client-entry" ];
};
in pkgs.pkgsStatic.rustPlatform.buildRustPackage {
  pname = "reverie-worker-client-entry";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-worker-client-entry" ];
  cargoTestFlags = [ "-p" "reverie-worker-client-entry" ];
  doCheck = true;
  meta = {
    description = "Static fixed-purpose worker client entry";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
