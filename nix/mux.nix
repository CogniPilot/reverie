# reverie-mux: list, inspect, attach and kill the console's tmux sessions from a terminal.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-mux" ];
  };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-mux";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-mux" ];
  cargoTestFlags = [ "-p" "reverie-mux" ];
  doCheck = true;
  # The console's runtime runs its tmux server with pkgs.tmux; the client here is the same build,
  # so it always finds a tmux and speaks the server's protocol.
  nativeBuildInputs = [ pkgs.makeWrapper ];
  postInstall = ''
    wrapProgram "$out/bin/reverie-mux" --prefix PATH : ${pkgs.tmux}/bin
  '';
  meta = {
    description = "List, inspect, attach and kill the Reverie console's tmux sessions";
    mainProgram = "reverie-mux";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
