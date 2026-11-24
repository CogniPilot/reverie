{ pkgs, src }:
let
  # Only this package's crate closure, so an unrelated change keeps its cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-contracts" "reverie-core" "reverie-laptop-tools" ];
  };
  sourceFile = relative: builtins.path { path = (src.origSrc or src) + "/${relative}"; };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-laptop-tools";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-laptop-tools" ];
  cargoTestFlags = [ "-p" "reverie-laptop-tools" ];
  REVERIE_TEST_MKFIFO = "${pkgs.coreutils}/bin/mkfifo";
  doCheck = true;
  postInstall = ''
    notices="$out/share/doc/reverie-laptop-tools"
    mkdir -p "$notices"
    cp ${sourceFile "THIRD_PARTY_NOTICES.md"} "$notices/THIRD_PARTY_NOTICES.md"
    cp ${sourceFile "crates/reverie-python-regex/CPYTHON-LICENSE"} "$notices/CPYTHON-LICENSE"
    cp ${sourceFile "crates/reverie-core/src/python_text/UNICODE_LICENSE.txt"} "$notices/UNICODE-LICENSE"
    cp ${sourceFile "vendor/regex-licenses/unicode_names2-1.2.2/LICENSE-MIT"} "$notices/UNICODE-NAMES2-LICENSE-MIT"
    cp ${sourceFile "vendor/regex-licenses/unicode_names2-1.2.2/LICENSE-APACHE"} "$notices/UNICODE-NAMES2-LICENSE-APACHE"
  '';
  meta = {
    description = "Native laptop development environment cache, tool launchers and Cargo defaults";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
