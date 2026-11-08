# Candidate factory only: installed launch selection requires native qualification.
{ pkgs, src }:
let
  producer = import ./perf-capsule-producer.nix { inherit pkgs src; };
  native = import ./perf-guest-native.nix { inherit pkgs src; };
  # Fixed stat/record/report never use annotation helper PATH. Retain the real
  # ELF before upstream's optional interactive annotation shell wrapper.
  perf = (import ./worker-perf.nix { inherit pkgs; }).overrideAttrs (_: {
    preFixup = "";
  });
  closure = pkgs.closureInfo { rootPaths = [ perf ]; };
  notices = import ./perf-capsule-notices.nix { inherit pkgs src perf; };
in pkgs.runCommand "reverie-perf-guest-capsule" {
  nativeBuildInputs = [ producer ];
  preferLocalBuild = true;
} ''
  reverie-perf-capsule \
    --checker ${native}/bin/reverie-perf-check --perf ${perf}/bin/perf \
    --closure ${closure}/store-paths --notices ${notices} \
    --patchelf ${pkgs.patchelf}/bin/patchelf --readelf ${pkgs.binutils}/bin/readelf \
    --output "$out"
''
