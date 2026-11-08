{ pkgs, src }:
let
  # Only this package's crate closure, so an unrelated change keeps its cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-core" "reverie-worker-client" ];
  };
in
rec {
  program = pkgs.rustPlatform.buildRustPackage {
    pname = "reverie-worker-client";
    version = "0.1.0";
    src = workspace.source;
    cargoLock.lockFile = workspace.lockFile;
    cargoBuildFlags = [ "-p" "reverie-worker-client" ];
    cargoTestFlags = [ "-p" "reverie-worker-client" ];
    doCheck = true;
    meta = {
      description = "Native client for the existing private Reverie worker broker";
      license = pkgs.lib.licenses.mit;
      platforms = pkgs.lib.platforms.linux;
    };
  };
  manifest = pkgs.runCommand "reverie-native-resource-client-manifest" {
    nativeBuildInputs = [ pkgs.coreutils pkgs.jq ];
  } ''
    mkdir -p "$out/share/reverie"
    executable="${program}/bin/reverie-worker-exec"
    test "$(readlink -f "$executable")" = "$executable"
    read -r digest rest < <(sha256sum "$executable")
    jq -n --arg executable "$executable" --arg digest "$digest" '{
      version: 2, purpose: "resource-replacement-native-client-v2",
      executable: $executable, executableSHA256: $digest,
      argvPrefix: [$executable], brokerWireVersion: 1
    }' > "$out/share/reverie/resource-client.json"
  '';
}
