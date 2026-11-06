{ pkgs, src, console }:
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-memory-cli";
  version = "0.1.0";
  inherit src;
  # nodejs_22/bin/node is a symlink to this canonical ELF, not a wrapper.
  REVERIE_FIXED_JOURNAL_NODE = "${pkgs.nodejs-slim_22}/bin/node";
  REVERIE_FIXED_JOURNAL_ENTRY = "${console}/lib/reverie/dist/index.js";
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoBuildFlags = [ "-p" "reverie-memory-cli" ];
  cargoTestFlags = [ "-p" "reverie-memory-cli" ];
  nativeCheckInputs = [ pkgs.coreutils ];
  doCheck = true;
  postInstall = ''
    regexNotices="$out/share/doc/reverie-memory-cli/regex"
    mkdir -p "$regexNotices"
    cp ${src}/THIRD_PARTY_NOTICES.md "$regexNotices/THIRD_PARTY_NOTICES.md"
    cp ${src}/crates/reverie-python-regex/CPYTHON-LICENSE "$regexNotices/CPYTHON-LICENSE"
    cp ${src}/crates/reverie-python-regex/NOTICE "$regexNotices/CPYTHON-SRE-NOTICE"
    cp ${src}/vendor/rustpython-sre-engine/LICENSE "$regexNotices/RUSTPYTHON-SRE-LICENSE"
    cp ${src}/vendor/rustpython-wtf8/LICENSE "$regexNotices/RUSTPYTHON-WTF8-LICENSE"
    cp ${src}/vendor/rustpython-wtf8/RUST-LICENSE-MIT "$regexNotices/RUST-WTF8-LICENSE-MIT"
    cp ${src}/vendor/rustpython-wtf8/RUST-LICENSE-APACHE "$regexNotices/RUST-WTF8-LICENSE-APACHE"
    cp ${src}/crates/reverie-core/src/python_text/UNICODE_LICENSE.txt "$regexNotices/UNICODE-LICENSE"
  '';
  meta = {
    description = "Native explicitly scoped memory and authenticated journal bridge candidate";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
