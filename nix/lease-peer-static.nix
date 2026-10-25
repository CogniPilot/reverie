{ pkgs, src, testRoots ? false }:
pkgs.pkgsStatic.stdenv.mkDerivation {
  pname = "reverie-acceptance-peer" + pkgs.lib.optionalString testRoots "-test-roots";
  version = "1";
  dontUnpack = true;
  buildPhase = ''
    $CC ${pkgs.lib.optionalString testRoots "-DREVERIE_TEST_ROOTS"} -std=c11 -Os -Wall -Wextra -Werror -static -no-pie \
      ${src}/python/reverie/cleanup/peer_static.c -lm -o reverie-acceptance-peer
  '';
  installPhase = ''
    mkdir -p "$out/bin"
    install -m555 reverie-acceptance-peer "$out/bin/reverie-acceptance-peer"
  '';
  meta.platforms = pkgs.lib.platforms.linux;
}
