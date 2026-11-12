{ pkgs, src, artifacts ? import ./policy-artifacts.nix { inherit pkgs src; } }:
pkgs.pkgsStatic.stdenv.mkDerivation {
  pname = "reverie-human-terminal-toolkit";
  version = "1";
  dontUnpack = true;
  nativeBuildInputs = [ pkgs.binutils artifacts ];
  buildPhase = ''
    $CC -std=c11 -O2 -Wall -Wextra -Werror -static -no-pie \
      ${src}/python/reverie/human_terminal_static.c -o reverie-human-shell
  '';
  installPhase = ''
    mkdir -p "$out/opt/reverie/human/bin" "$out/share/reverie-human-terminal"
    install -m555 reverie-human-shell "$out/opt/reverie/human/bin/reverie-human-shell"
    cp -L ${pkgs.pkgsStatic.bash}/bin/bash "$out/opt/reverie/human/bin/bash"
    chmod 555 "$out/opt/reverie/human/bin/bash"
    for program in "$out/opt/reverie/human/bin/"*; do
      readelf -l "$program" > program-headers
      readelf -d "$program" > dynamic-entries
      if grep -q INTERP program-headers || grep -q NEEDED dynamic-entries; then
        echo 'Human terminal toolkit must contain only static ELF programs' >&2
        exit 1
      fi
    done
    ${artifacts}/bin/reverie-policy-artifacts human-terminal-manifest \
      --root "$out" --system ${pkgs.stdenv.hostPlatform.system}
  '';
  meta.platforms = pkgs.lib.platforms.linux;
}
