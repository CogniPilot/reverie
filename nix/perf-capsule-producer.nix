{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [ "reverie-perf-capsule" "reverie-elf-bundle" ];
  };
  originFixture = import ./memory-capsule-origin-fixture.nix { inherit pkgs; };
in pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-perf-capsule-producer";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-perf-capsule" ];
  cargoTestFlags = [ "-p" "reverie-elf-bundle" ];
  postCheck = ''
    REVERIE_TEST_CAPSULE_ORIGINS=${originFixture} \
    REVERIE_TEST_CAPSULE_PATCHELF=${pkgs.patchelf}/bin/patchelf \
    REVERIE_TEST_CAPSULE_READELF=${pkgs.binutils}/bin/readelf \
    cargo test --locked --release --target ${pkgs.stdenv.hostPlatform.rust.rustcTarget} -p reverie-elf-bundle \
      -- --ignored --exact libraries::tests::equal_bytes_at_distinct_origins_cannot_hide_conflicting_dependency_contents
  '';
  meta = {
    description = "Build-time fixed guest perf capsule assembler";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
