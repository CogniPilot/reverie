# Preserve upstream source notices; no runtime helpers or interpreters included.
{ pkgs, src, perf }:
let
  # Upstream perf's complete build inputs include its selected runtime libraries.
  # Preserve their source license trees and the libc/compiler runtime notices.
  packages = pkgs.lib.unique (perf.buildInputs ++ [ pkgs.glibc pkgs.gcc.cc ]);
  notice = package: pkgs.stdenvNoCC.mkDerivation {
    pname = "reverie-perf-notices-${package.pname or package.name}";
    version = package.version or "source";
    src = package.src;
    dontBuild = true;
    dontConfigure = true;
    installPhase = ''
      mkdir -p "$out"
      find . -type f \( -iname 'copying*' -o -iname '*license*' -o -iname 'notice*' -o -iname 'copyright*' -o -ipath '*/licenses/*' \) \
        -exec cp --parents -- '{}' "$out/" \;
      test -n "$(find "$out" -type f -print -quit)"
    '';
  };
  sourceFile = relative: builtins.path { path = (src.origSrc or src) + "/${relative}"; };
in pkgs.runCommand "reverie-perf-capsule-notices" {} ''
  mkdir -p "$out/native"
  cp ${sourceFile "THIRD_PARTY_NOTICES.md"} "$out/native/THIRD_PARTY_NOTICES.md"
  cp -r ${sourceFile "vendor/regex-licenses"} "$out/native/regex-licenses"
  cp ${sourceFile "crates/reverie-python-regex/CPYTHON-LICENSE"} "$out/native/CPYTHON-LICENSE"
  cp ${sourceFile "crates/reverie-python-regex/NOTICE"} "$out/native/CPYTHON-SRE-NOTICE"
  cp ${sourceFile "vendor/rustpython-sre-engine/LICENSE"} "$out/native/RUSTPYTHON-SRE-LICENSE"
  cp ${sourceFile "vendor/rustpython-wtf8/LICENSE"} "$out/native/RUSTPYTHON-WTF8-LICENSE"
  cp ${sourceFile "vendor/rustpython-wtf8/RUST-LICENSE-MIT"} "$out/native/RUST-WTF8-LICENSE-MIT"
  cp ${sourceFile "vendor/rustpython-wtf8/RUST-LICENSE-APACHE"} "$out/native/RUST-WTF8-LICENSE-APACHE"
  cp ${sourceFile "crates/reverie-core/src/python_text/UNICODE_LICENSE.txt"} "$out/native/UNICODE-LICENSE"
  ${pkgs.lib.concatStringsSep "\n" (pkgs.lib.imap0 (index: package:
    ''cp -r ${notice package} "$out/${toString index}-${package.pname or package.name}"''
  ) (packages ++ [ perf ]))}
''
