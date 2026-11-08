{ pkgs, src, console }:
let
  # Only this package's crate closure, so an unrelated change keeps its cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-contracts" "reverie-core" "reverie-diagnostics" "reverie-host" "reverie-http" "reverie-python-regex" "reverie-store" "reverie-application" "reverie-memory-cli" ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
  sourceFile = relative: builtins.path { path = (src.origSrc or src) + "/${relative}"; };
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-memory-cli";
  version = "0.1.0";
  src = workspace.source;
  # nodejs_22/bin/node is a symlink to this canonical ELF, not a wrapper.
  REVERIE_FIXED_JOURNAL_NODE = "${pkgs.nodejs-slim_22}/bin/node";
  REVERIE_FIXED_JOURNAL_ENTRY = "${console}/lib/reverie/dist/index.js";
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-memory-cli" ];
  cargoTestFlags = [ "-p" "reverie-memory-cli" ];
  nativeCheckInputs = [ pkgs.coreutils ];
  doCheck = true;
  postInstall = ''
    regexNotices="$out/share/doc/reverie-memory-cli/regex"
    mkdir -p "$regexNotices"
    cp ${sourceFile "THIRD_PARTY_NOTICES.md"} "$regexNotices/THIRD_PARTY_NOTICES.md"
    cp ${sourceFile "crates/reverie-python-regex/CPYTHON-LICENSE"} "$regexNotices/CPYTHON-LICENSE"
    cp ${sourceFile "crates/reverie-python-regex/NOTICE"} "$regexNotices/CPYTHON-SRE-NOTICE"
    cp ${sourceFile "vendor/rustpython-sre-engine/LICENSE"} "$regexNotices/RUSTPYTHON-SRE-LICENSE"
    cp ${sourceFile "vendor/rustpython-wtf8/LICENSE"} "$regexNotices/RUSTPYTHON-WTF8-LICENSE"
    cp ${sourceFile "vendor/rustpython-wtf8/RUST-LICENSE-MIT"} "$regexNotices/RUST-WTF8-LICENSE-MIT"
    cp ${sourceFile "vendor/rustpython-wtf8/RUST-LICENSE-APACHE"} "$regexNotices/RUST-WTF8-LICENSE-APACHE"
    cp ${sourceFile "crates/reverie-core/src/python_text/UNICODE_LICENSE.txt"} "$regexNotices/UNICODE-LICENSE"
    cp ${sourceFile "vendor/regex-licenses/unicode_names2-1.2.2/LICENSE-MIT"} "$regexNotices/UNICODE-NAMES2-LICENSE-MIT"
    cp ${sourceFile "vendor/regex-licenses/unicode_names2-1.2.2/LICENSE-APACHE"} "$regexNotices/UNICODE-NAMES2-LICENSE-APACHE"
  '';
  meta = {
    description = "Native explicitly scoped memory and authenticated journal bridge candidate";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
