# Observation producers only; these do not grant pruning or authenticated effects.
{ pkgs, src }:
pkgs.runCommand "reverie-cleanup-observations" {
  nativeBuildInputs = [ pkgs.makeWrapper pkgs.python3 ];
  meta.platforms = pkgs.lib.platforms.linux;
} ''
  mkdir -p "$out/bin" "$out/libexec/reverie"
  install -m444 ${src}/python/reverie/cleanup/collector.py "$out/libexec/reverie/collector.py"
  install -m444 ${src}/python/reverie/cleanup/receipts.py "$out/libexec/reverie/receipts.py"
  install -m444 ${src}/python/reverie/cleanup/collector_state.py "$out/libexec/reverie/collector_state.py"
  printf '%s  %s\n' \
    '20aca9af5e5d30b757f8b366a0dda0ec3aac15b9fb63af88aa65ca58f0db6dcf' "$out/libexec/reverie/collector.py" \
    'e0c74d139680364b8069627d718bd8389a1c42c0e3732538adeb63da7f21b626' "$out/libexec/reverie/receipts.py" \
    | sha256sum --check --status
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-collect" \
    --add-flags "-I -B $out/libexec/reverie/collector.py"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-prune-receipts" \
    --add-flags "-I -B $out/libexec/reverie/receipts.py"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-collect-state" \
    --add-flags "-I -B $out/libexec/reverie/collector_state.py"
  "$out/bin/reverie-collect" --help > /dev/null
  "$out/bin/reverie-prune-receipts" --help > /dev/null
  "$out/bin/reverie-collect-state" --help > /dev/null
  cp "$out/libexec/reverie/collector.py" reverie_collect.py
  cp "$out/libexec/reverie/receipts.py" prune_receipts.py
  cp ${src}/tests/cleanup_sources/test_reverie_collect.py test_reverie_collect.py
  cp ${src}/tests/cleanup_sources/test_prune_receipts.py test_prune_receipts.py
  python3 -I -B -X dev -W error::ResourceWarning test_reverie_collect.py
  python3 -I -B test_prune_receipts.py
  chmod -R a-w "$out"
''
