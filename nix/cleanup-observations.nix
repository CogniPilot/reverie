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
  install -m444 ${src}/python/reverie/cleanup/collector_user.py "$out/libexec/reverie/collector_user.py"
  install -m444 ${src}/python/reverie/cleanup/collector_history.py "$out/libexec/reverie/collector_history.py"
  cat > "$out/libexec/reverie/collector-runtime.json" <<'JSON'
  {"python":"${pkgs.python3}/bin/python3","systemctl":"${pkgs.systemd}/bin/systemctl"}
  JSON
  printf '%s  %s\n' \
    '113dba6a1e0094b0431eda05cf1ba3f4f6b0bd29bad151f5cc40d512ff66b113' "$out/libexec/reverie/collector.py" \
    '6681e2e6e6291b3f1ee383c110a39f7d0dd09e1c7b61e07ae2dfe308672646ab' "$out/libexec/reverie/receipts.py" \
    'cf76217a3176ed443b6057b1cfd7b632b4e4b264c9f8e676264d743651d15899' "$out/libexec/reverie/collector_state.py" \
    'cc04f1e1f34719244cea905c6018f8c5e352bad2b739bfcb2ae8ab27ebc9625f' "$out/libexec/reverie/collector_user.py" \
    'e0150804f6dfe9b4b6297f911f80475313f59c677b2a1ffa2f8c59f95c4f1626' "$out/libexec/reverie/collector_history.py" \
    | sha256sum --check --status
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-collect" \
    --add-flags "-I -B $out/libexec/reverie/collector.py"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-prune-receipts" \
    --add-flags "-I -B $out/libexec/reverie/receipts.py"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-collect-state" \
    --add-flags "-I -B $out/libexec/reverie/collector_state.py"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-observations" \
    --add-flags "-I -B $out/libexec/reverie/collector_user.py"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-resource-history" \
    --add-flags "-I -B $out/libexec/reverie/collector_history.py"
  "$out/bin/reverie-collect" --help > /dev/null
  "$out/bin/reverie-prune-receipts" --help > /dev/null
  "$out/bin/reverie-collect-state" --help > /dev/null
  "$out/bin/reverie-observations" --help > /dev/null
  "$out/bin/reverie-resource-history" --help > /dev/null
  cp "$out/libexec/reverie/collector.py" reverie_collect.py
  cp "$out/libexec/reverie/receipts.py" prune_receipts.py
  cp ${src}/tests/cleanup_sources/test_reverie_collect.py test_reverie_collect.py
  cp ${src}/tests/cleanup_sources/test_prune_receipts.py test_prune_receipts.py
  python3 -I -B -X dev -W error::ResourceWarning test_reverie_collect.py
  python3 -I -B test_prune_receipts.py
  chmod -R a-w "$out"
''
