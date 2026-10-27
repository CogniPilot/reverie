# Optional source-built diagnostic candidate. It never supplies bin/codex.
{ pkgs }:
let
  inherit (pkgs) lib;
  provenance = builtins.fromJSON (builtins.readFile ./codex-observer/provenance.json);
  lockFile = ./codex-observer/Cargo.lock;
  outputHashes = builtins.fromJSON (builtins.readFile ./codex-observer/git-output-hashes.json);
  archive = pkgs.fetchurl {
    name = "codex-${provenance.upstreamRevision}.tar.gz";
    url = provenance.upstreamArchiveUrl;
    hash = provenance.upstreamArchiveHash;
  };
  patchedSource = pkgs.applyPatches {
    name = "codex-observer-source-${provenance.version}";
    src = archive;
    patches = [ ./codex-observer/observer-r5.patch ];
  };
  cargoDeps = pkgs.rustPlatform.importCargoLock {
    inherit outputHashes;
    # Content only: keep unrelated checkout metadata out of the vendor closure.
    lockFileContents = builtins.readFile lockFile;
    allowBuiltinFetchGit = false;
  };
  sourceCheck = pkgs.runCommand "codex-observer-source-check" { } ''
    ${pkgs.python3}/bin/python3 -I -B ${./codex-observer/verify-inputs.py} source \
      ${patchedSource} ${./codex-observer/provenance.json} ${./codex-observer/git-output-hashes.json} > "$out"
  '';
  vendorCheck = pkgs.runCommand "codex-observer-vendor-check" {
    nativeBuildInputs = [ pkgs.cargo pkgs.rustc ];
  } ''
    ${pkgs.python3}/bin/python3 -I -B ${./codex-observer/verify-inputs.py} vendor \
      ${cargoDeps} ${./codex-observer/provenance.json} ${./codex-observer/git-output-hashes.json} > "$out"
    cp -R ${patchedSource} source
    chmod -R u+w source
    mkdir -p source/.cargo "$TMPDIR/cargo-home"
    substitute ${cargoDeps}/.cargo/config.toml source/.cargo/config.toml \
      --replace-fail 'directory = "cargo-vendor-dir"' 'directory = "${cargoDeps}"'
    export CARGO_HOME="$TMPDIR/cargo-home" CARGO_NET_OFFLINE=true
    pushd source/codex-rs
    cargo metadata --locked --offline --format-version 1 --no-deps > "$TMPDIR/metadata.json"
    popd
    ${pkgs.python3}/bin/python3 -I -B - "$out" "$TMPDIR/metadata.json" <<'PY'
import json, sys
result = json.load(open(sys.argv[1]))
metadata = json.load(open(sys.argv[2]))
result.update(lockedOfflineCargoMetadata=True, workspaceMembers=len(metadata["workspace_members"]))
json.dump(result, open(sys.argv[1], "w"), sort_keys=True)
PY
  '';
  candidate = pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-codex-observer";
  version = provenance.version;
  src = patchedSource;
  inherit cargoDeps;
  cargoRoot = "codex-rs";
  buildAndTestSubdir = "codex-rs";
  # This is the profile actually checked and exercised by the native canary.
  # Nix stripping/fixup still produces a distinct artifact needing acceptance.
  buildType = "debug";
  cargoBuildFlags = [ "--locked" "--package" "codex-cli" "--bin" "codex" ];
  strictDeps = true;
  nativeBuildInputs = with pkgs; [ clang cmake makeBinaryWrapper pkg-config ];
  buildInputs = with pkgs; [ libclang openssl libcap ];
  env = {
    LIBCLANG_PATH = "${lib.getLib pkgs.libclang}/lib";
    CARGO_NET_OFFLINE = "true";
  };
  # Focused source/vendor checks are separate. The complete upstream suite needs
  # native host capabilities and must not be represented as passing here.
  doCheck = false;
  postInstall = ''
    install -Dm644 ${patchedSource}/LICENSE "$out/share/licenses/reverie-codex-observer/LICENSE"
    if test -f ${patchedSource}/NOTICE; then
      install -Dm644 ${patchedSource}/NOTICE "$out/share/licenses/reverie-codex-observer/NOTICE"
    fi
    mkdir -p "$out/libexec"
    mv "$out/bin/codex" "$out/libexec/codex-observer"
    makeBinaryWrapper "$out/libexec/codex-observer" "$out/bin/codex-observer" \
      --prefix PATH : ${lib.makeBinPath (with pkgs; [ bubblewrap ripgrep gitMinimal bash ])}
    test ! -e "$out/bin/codex"
  '';
  passthru = {
    inherit archive patchedSource;
    upstreamRevision = provenance.upstreamRevision;
    observationDefault = "off";
    tests = { source = sourceCheck; vendor = vendorCheck; native = nativeCheck; };
  };
  meta = {
    description = "Optional Codex candidate with default-off redacted native hook diagnostics";
    homepage = "https://github.com/openai/codex";
    license = lib.licenses.asl20;
    platforms = lib.platforms.linux;
    mainProgram = "codex-observer";
  };
  };
  # Explicit optional output: excluded from ordinary flake checks so qualifying
  # public inputs does not silently compile the complete Rust graph.
  nativeCheck = candidate.overrideAttrs (_: {
    pname = "reverie-codex-observer-native-check";
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      pushd codex-rs
      export CODEX_REDACTED_HOOK_OBSERVER=1
      cargo check --locked --offline --all-targets -j "$NIX_BUILD_CORES" -p codex-hooks -p codex-core -p codex-tui
      cargo test --locked --offline -j "$NIX_BUILD_CORES" -p codex-hooks hook_dispatch_observer -- --ignored --test-threads=1
      cargo test --locked --offline -j "$NIX_BUILD_CORES" -p codex-core --lib hook_context_observer -- --ignored --test-threads=1
      popd
      runHook postCheck
    '';
    passthru = { };
  });
in
assert lib.assertMsg (pkgs.rustc.version == "1.95.0") "Codex observer candidate requires the reviewed Rust 1.95.0 toolchain";
assert lib.assertMsg (builtins.hashFile "sha256" ./codex-observer/observer-r5.patch == provenance.patchSha256) "Codex observer patch pin mismatch";
assert lib.assertMsg (builtins.hashFile "sha256" lockFile == provenance.lockSha256) "Codex observer lock pin mismatch";
candidate
