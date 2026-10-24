{ pkgs }:
let
  version = "0.9.20";
  platform = {
    x86_64-linux = { name = "x86_64"; hash = "sha256:629661600079311288a0d2f41cd9d211f59c185650d1bdc12803a6d6b25e0f7c"; };
    aarch64-linux = { name = "aarch64"; hash = "sha256:d25b0108e3e2b952b73de06396cd8571c1ac2ee563fbd40a99b6825cedd078ef"; };
  }.${pkgs.stdenv.hostPlatform.system};
in pkgs.stdenvNoCC.mkDerivation {
  pname = "reverie-chat-rumoca-lsp";
  inherit version;
  src = pkgs.fetchurl {
    url = "https://github.com/CogniPilot/rumoca/releases/download/v${version}/rumoca-lsp-linux-${platform.name}";
    hash = platform.hash;
  };
  dontUnpack = true;
  installPhase = ''
    runHook preInstall
    install -Dm755 "$src" "$out/bin/rumoca-lsp"
    runHook postInstall
  '';
  meta = {
    description = "Optional pinned Rumoca language server for explicit chat snippet assistance";
    homepage = "https://github.com/CogniPilot/rumoca";
    license = pkgs.lib.licenses.asl20;
    platforms = [ "x86_64-linux" "aarch64-linux" ];
  };
}
