{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-core" "reverie-python-regex" "reverie-hands-tools" ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
  toolchain = pkgs.buildEnv {
    name = "reverie-hands-toolchain";
    # Git already comes from the laptop runtime's /bin.
    paths = [ pkgs.nodejs_22 pkgs.bashInteractive pkgs.coreutils
      pkgs.ripgrep pkgs.findutils pkgs.gnused pkgs.gnugrep pkgs.gnumake ];
    pathsToLink = [ "/bin" ];
  };
  notices = {
    "THIRD_PARTY_NOTICES.md" = "THIRD_PARTY_NOTICES.md";
    "CPYTHON-LICENSE" = "crates/reverie-python-regex/CPYTHON-LICENSE";
    "CPYTHON-SRE-NOTICE" = "crates/reverie-python-regex/NOTICE";
    "RUSTPYTHON-SRE-LICENSE" = "vendor/rustpython-sre-engine/LICENSE";
    "RUSTPYTHON-WTF8-LICENSE" = "vendor/rustpython-wtf8/LICENSE";
    "RUST-WTF8-LICENSE-MIT" = "vendor/rustpython-wtf8/RUST-LICENSE-MIT";
    "RUST-WTF8-LICENSE-APACHE" = "vendor/rustpython-wtf8/RUST-LICENSE-APACHE";
    "UNICODE-LICENSE" = "crates/reverie-core/src/python_text/UNICODE_LICENSE.txt";
    "UNICODE-NAMES2-LICENSE-MIT" = "vendor/regex-licenses/unicode_names2-1.2.2/LICENSE-MIT";
    "UNICODE-NAMES2-LICENSE-APACHE" = "vendor/regex-licenses/unicode_names2-1.2.2/LICENSE-APACHE";
  };
  sourceFile = relative: builtins.path { path = (src.origSrc or src) + "/${relative}"; };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-hands-tools";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-hands-tools" ];
  cargoTestFlags = [ "-p" "reverie-hands-tools" ];
  REVERIE_HANDS_TOOL_PATH = "${toolchain}/bin";
  nativeCheckInputs = [ pkgs.coreutils ];
  disallowedRequisites = [ pkgs.python3 ];
  postInstall = pkgs.lib.concatStringsSep "\n" (pkgs.lib.mapAttrsToList
    (name: relative: ''install -Dm444 ${sourceFile relative} "$out/share/doc/reverie-hands-tools/${name}"'')
    notices);
  meta = {
    mainProgram = "reverie-hands-tools";
    description = "Native Hands laptop workspace tools";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
