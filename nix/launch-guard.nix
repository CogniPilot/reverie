{ pkgs, src }:
let
  sourceFile = import ./source-file.nix src;
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-launch-guard" "reverie-contracts" "reverie-core" ];
  };
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-launch-guard";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-launch-guard" ];
  cargoTestFlags = [ "-p" "reverie-launch-guard" ];
  disallowedRequisites = [ pkgs.python3 ];
  postPatch = ''
    mkdir -p examples schemas
    cp ${sourceFile "examples/launch-guard-input.json"} examples/launch-guard-input.json
    cp ${sourceFile "schemas/launch-guard-receipt-v1.json"} schemas/launch-guard-receipt-v1.json
  '';
  meta = {
    description = "Evaluate metadata-only launch guard fixtures without live effects";
    license = pkgs.lib.licenses.mit;
    mainProgram = "reverie-launch-guard";
  };
}
