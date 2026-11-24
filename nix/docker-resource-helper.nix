# Fixed static Docker-owned cgroup/storage observer. No writable /nix dependency.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-docker-resources" ];
  };
in pkgs.pkgsStatic.rustPlatform.buildRustPackage {
  pname = "reverie-docker-resources";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-docker-resources" ];
  doCheck = true;
  cargoTestFlags = [ "-p" "reverie-docker-resources" ];
  postInstall = ''
    mkdir -p "$out/opt/reverie-worker-tools"
    ln -s "$out/bin/reverie-docker-resources" "$out/opt/reverie-worker-tools/reverie-docker-resources"
  '';
  meta = {
    description = "Fixed Docker-contained new-pool and worker resource/storage operations";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
