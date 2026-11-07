{ pkgs, src }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-laptop-tools";
  version = "0.1.0";
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-laptop-tools" ];
  cargoTestFlags = [ "-p" "reverie-laptop-tools" ];
  REVERIE_TEST_MKFIFO = "${pkgs.coreutils}/bin/mkfifo";
  doCheck = true;
  postInstall = ''
    notices="$out/share/doc/reverie-laptop-tools"
    mkdir -p "$notices"
    cp ${src}/THIRD_PARTY_NOTICES.md "$notices/THIRD_PARTY_NOTICES.md"
    cp ${src}/crates/reverie-python-regex/CPYTHON-LICENSE "$notices/CPYTHON-LICENSE"
    cp ${src}/crates/reverie-core/src/python_text/UNICODE_LICENSE.txt "$notices/UNICODE-LICENSE"
    cp ${src}/vendor/regex-licenses/unicode_names2-1.2.2/LICENSE-MIT "$notices/UNICODE-NAMES2-LICENSE-MIT"
    cp ${src}/vendor/regex-licenses/unicode_names2-1.2.2/LICENSE-APACHE "$notices/UNICODE-NAMES2-LICENSE-APACHE"
  '';
  meta = {
    description = "Native laptop development environment cache, tool launchers and Cargo defaults";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
