{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-kokoro" ];
  };
  engine = import ./kokoro-engine.nix { inherit pkgs src; };
in pkgs.rustPlatform.buildRustPackage (engine // {
  pname = "reverie-kokoro";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-kokoro" ];
  cargoTestFlags = [ "-p" "reverie-kokoro" ];
  postInstall = ''
    mkdir -p "$out/share/licenses/reverie-kokoro"
    cp crates/reverie-kokoro/LICENSE-kokoro-onnx "$out/share/licenses/reverie-kokoro/"
  '';
  meta = {
    description = "Local Kokoro speech service using native ONNX Runtime and eSpeak NG";
    mainProgram = "reverie-kokoro";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
})
