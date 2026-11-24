{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-worker-tools-capsule" "reverie-elf-bundle" ];
  };
  origins = import ./memory-capsule-origin-fixture.nix { inherit pkgs; };
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-worker-tools-capsule-producer";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-worker-tools-capsule" ];
  cargoTestFlags = [ "-p" "reverie-elf-bundle" "-p" "reverie-worker-tools-capsule" ];
  doCheck = true;
  nativeCheckInputs = [ pkgs.clippy ];
  postCheck = ''
    cargo clippy --locked --offline --release --target ${pkgs.stdenv.hostPlatform.rust.rustcTarget} \
      -p reverie-elf-bundle -p reverie-worker-tools-capsule --all-targets --all-features -- -D warnings
    REVERIE_TEST_CAPSULE_ORIGINS=${origins} \
    REVERIE_TEST_CAPSULE_PATCHELF=${pkgs.patchelf}/bin/patchelf \
    REVERIE_TEST_CAPSULE_READELF=${pkgs.binutils}/bin/readelf \
    cargo test --locked --release --target ${pkgs.stdenv.hostPlatform.rust.rustcTarget} -p reverie-elf-bundle \
      -- --ignored --exact libraries::tests::equal_bytes_at_distinct_origins_cannot_hide_conflicting_dependency_contents
  '';
  meta = { description = "Build-time fixed worker tmux capsule"; license = pkgs.lib.licenses.mit; platforms = pkgs.lib.platforms.linux; };
}
