# Separate r12 initializer; the r8 portable bootstrap remains unchanged.
{ pkgs, src, prune ? import ./prune-r12.nix { inherit pkgs src; } }:
pkgs.runCommand "reverie-prune-declared-r12" {
  nativeBuildInputs = [ pkgs.makeWrapper ];
  passthru = { inherit (prune) sourceHashes; dryRunOnly = true; };
  meta = {
    description = "Immutable r12 initializer and inventory for declared dry-run cleanup";
    mainProgram = "reverie-prune-declared";
    platforms = pkgs.lib.platforms.linux;
  };
} ''
  mkdir -p "$out/bin" "$out/libexec/reverie"
  for name in host_install declarative declarative_r12; do
    install -m444 "${src}/python/reverie/cleanup/$name.py" "$out/libexec/reverie/$name.py"
  done
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-prune-declared" \
    --add-flags "-I -B $out/libexec/reverie/declarative_r12.py" \
    --add-flags "--package ${prune} --python ${pkgs.python3}/bin/python3" \
    --add-flags "--docker ${pkgs.docker-client}/bin/docker --systemctl ${pkgs.systemd}/bin/systemctl" \
    --add-flags "--nix-store ${pkgs.nix}/bin/nix-store --closure $out"
  "$out/bin/reverie-prune-declared" --help > /dev/null
  chmod -R a-w "$out"
''
