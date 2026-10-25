{ pkgs, src, prune ? import ./prune.nix { inherit pkgs src; } }:
pkgs.runCommand "reverie-prune-host" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  meta = {
    description = "Prepare an inactive owner-installed dry-run cleanup service";
    mainProgram = "reverie-prune-host";
    platforms = pkgs.lib.platforms.linux;
  };
} ''
  mkdir -p "$out/bin" "$out/libexec/reverie"
  install -m444 ${src}/python/reverie/cleanup/host_install.py "$out/libexec/reverie/host_install.py"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-prune-host" \
    --add-flags "-I -B $out/libexec/reverie/host_install.py" \
    --add-flags "--package ${prune} --python ${pkgs.python3}/bin/python3" \
    --add-flags "--docker ${pkgs.docker-client}/bin/docker --systemctl ${pkgs.systemd}/bin/systemctl" \
    --add-flags "--nix-store ${pkgs.nix}/bin/nix-store --closure $out"
  "$out/bin/reverie-prune-host" --help > /dev/null
  chmod -R a-w "$out"
''
