# Checked runtime ELF closure outside writable private /nix; no host services.
{ pkgs, src }:
let
  producer = import ./worker-tools-capsule-producer.nix { inherit pkgs src; };
  tmux = pkgs.tmux;
  locales = pkgs.glibcLocales.override { allLocales = false; locales = [ "C.UTF-8/UTF-8" "en_US.UTF-8/UTF-8" ]; };
  closure = pkgs.closureInfo { rootPaths = [ tmux ]; };
  terminfo = pkgs.runCommand "reverie-worker-terminfo" {} ''
    mkdir -p "$out"
    cp -rL ${pkgs.ncurses}/share/terminfo/. "$out/"
    chmod -R a-w "$out"
  '';
  notices = pkgs.runCommand "reverie-worker-tools-notices" {} ''
    mkdir -p "$out"
    cp ${tmux.src}/COPYING "$out/tmux-COPYING"
    cp ${src}/apps/web/LICENSE "$out/Reverie-LICENSE"
    cp ${src}/THIRD_PARTY_NOTICES.md "$out/Reverie-THIRD-PARTY-NOTICES.md"
  '';
in pkgs.runCommand "reverie-worker-tools-capsule" {
  nativeBuildInputs = [ producer ];
  preferLocalBuild = true;
  passthru = {
    executable = "/opt/reverie-worker-tools/bin/tmux";
    terminfo = "/opt/reverie-worker-tools/share/terminfo";
    manifest = "/opt/reverie-worker-tools/manifest.json";
  };
} ''
  reverie-worker-tools-capsule --tmux ${tmux}/bin/tmux --closure ${closure}/store-paths \
    --terminfo ${terminfo} --notices ${notices} --locale-archive ${locales}/lib/locale/locale-archive \
    --patchelf ${pkgs.patchelf}/bin/patchelf --readelf ${pkgs.binutils}/bin/readelf --output "$out"
''
