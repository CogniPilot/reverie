# Different build-time purpose, never a runtime environment/argument selector.
{ pkgs, src }:
let
  prefix = "/opt/reverie/memory";
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [
      "reverie-core" "reverie-contracts" "reverie-store" "reverie-host"
      "reverie-application" "reverie-http" "reverie-diagnostics"
      "reverie-python-regex" "reverie-memory-cli" "reverie-mcp-cli"
    ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
  sourceFile = relative: builtins.path { path = (src.origSrc or src) + "/${relative}"; };
in pkgs.pkgsStatic.rustPlatform.buildRustPackage {
  pname = "reverie-memory-guest-tools";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  REVERIE_MEMORY_GUEST_CAPSULE = "v1";
  REVERIE_FIXED_JOURNAL_NODE = "${prefix}/bin/node";
  REVERIE_FIXED_JOURNAL_ENTRY = "${prefix}/console/dist/index.js";
  REVERIE_FIXED_MCP_NODE = "${prefix}/bin/node";
  REVERIE_FIXED_MCP_ENTRY = "${prefix}/console/dist/installed-mcp-entry.js";
  REVERIE_FIXED_MCP_MEMORY = "${prefix}/bin/reverie-memory";
  cargoBuildFlags = [ "-p" "reverie-memory-cli" "-p" "reverie-mcp-cli" ];
  # Qualify the real ancillary ABI under musl too. Actual fixed-path memory/MCP
  # execution is separately qualified inside the owned image namespace.
  doCheck = true;
  cargoTestFlags = [ "-p" "reverie-host" "--lib" "native::owned_process::tests" ];
  nativeCheckInputs = [ pkgs.rustc ];
  preCheck = ''
    # The controlled child fixture uses the native rustc target, not Cargo's
    # musl target. Add its compiler only AFTER the static production build;
    # activating a second compiler setup hook earlier poisons cross link flags.
    export PATH="${pkgs.stdenv.cc}/bin:$PATH"
    unset NIX_CFLAGS_COMPILE NIX_LDFLAGS
  '';
  postCheck = ''
    # Static libc is also a numerical compatibility boundary. Exercise the
    # existing Python bit/BLOB, real-power and ranking fixtures on that target,
    # rather than treating a successful link as memory-result parity.
    cargo test --locked --release \
      --target ${pkgs.pkgsStatic.stdenv.hostPlatform.rust.rustcTarget} \
      -p reverie-core --test memory_embedding --test memory_ranking
  '';
  postInstall = ''
    mkdir -p "$out/share/doc/reverie-memory-guest"
    cp ${sourceFile "THIRD_PARTY_NOTICES.md"} "$out/share/doc/reverie-memory-guest/THIRD_PARTY_NOTICES.md"
    cp -r ${sourceFile "vendor/regex-licenses"} "$out/share/doc/reverie-memory-guest/regex-licenses"
    cp ${sourceFile "crates/reverie-python-regex/CPYTHON-LICENSE"} "$out/share/doc/reverie-memory-guest/CPYTHON-LICENSE"
    cp ${sourceFile "crates/reverie-python-regex/NOTICE"} "$out/share/doc/reverie-memory-guest/CPYTHON-SRE-NOTICE"
    cp ${sourceFile "vendor/rustpython-sre-engine/LICENSE"} "$out/share/doc/reverie-memory-guest/RUSTPYTHON-SRE-LICENSE"
    cp ${sourceFile "vendor/rustpython-wtf8/LICENSE"} "$out/share/doc/reverie-memory-guest/RUSTPYTHON-WTF8-LICENSE"
    cp ${sourceFile "vendor/rustpython-wtf8/RUST-LICENSE-MIT"} "$out/share/doc/reverie-memory-guest/RUST-WTF8-LICENSE-MIT"
    cp ${sourceFile "vendor/rustpython-wtf8/RUST-LICENSE-APACHE"} "$out/share/doc/reverie-memory-guest/RUST-WTF8-LICENSE-APACHE"
    cp ${sourceFile "crates/reverie-core/src/python_text/UNICODE_LICENSE.txt"} "$out/share/doc/reverie-memory-guest/UNICODE-LICENSE"
  '';
  meta = {
    description = "Static fixed-purpose guest memory entry (unselected candidate)";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
