# Observation producers only; these do not grant pruning or authenticated effects.
{ pkgs, src }:
let
  # The collector, USER observations, resource history reader and state
  # initializer are native; only the prune receipts remain here.
  observationsCli = import ./observations-cli.nix { inherit pkgs src; };
in
pkgs.runCommand "reverie-cleanup-observations" {
  nativeBuildInputs = [ pkgs.makeWrapper pkgs.python3 ];
  meta.platforms = pkgs.lib.platforms.linux;
} ''
  mkdir -p "$out/bin" "$out/libexec/reverie"
  install -m444 ${src}/python/reverie/cleanup/receipts.py "$out/libexec/reverie/receipts.py"
  printf '%s  %s\n' \
    '6681e2e6e6291b3f1ee383c110a39f7d0dd09e1c7b61e07ae2dfe308672646ab' "$out/libexec/reverie/receipts.py" \
    | sha256sum --check --status
  ln -s ${observationsCli}/bin/reverie-collect "$out/bin/reverie-collect"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-prune-receipts" \
    --add-flags "-I -B $out/libexec/reverie/receipts.py"
  ln -s ${observationsCli}/bin/reverie-observations "$out/bin/reverie-observations"
  ln -s ${observationsCli}/bin/reverie-collect-state "$out/bin/reverie-collect-state"
  ln -s ${observationsCli}/bin/reverie-resource-history "$out/bin/reverie-resource-history"
  "$out/bin/reverie-collect" --help > /dev/null
  "$out/bin/reverie-prune-receipts" --help > /dev/null
  "$out/bin/reverie-collect-state" --help > /dev/null
  "$out/bin/reverie-observations" --help > /dev/null
  "$out/bin/reverie-resource-history" --help > /dev/null
  cp "$out/libexec/reverie/receipts.py" prune_receipts.py
  cp ${src}/tests/cleanup_sources/test_prune_receipts.py test_prune_receipts.py
  python3 -I -B test_prune_receipts.py
  chmod -R a-w "$out"
''
