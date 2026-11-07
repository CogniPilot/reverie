# Observation producers only; these do not grant pruning or authenticated effects.
{ pkgs, src }:
let
  # The resource history reader and the prune receipts are native; the
  # collector remains here.
  historyCli = import ./observations-cli.nix { inherit pkgs src; };
in
pkgs.runCommand "reverie-cleanup-observations" {
  nativeBuildInputs = [ pkgs.makeWrapper pkgs.python3 ];
  meta.platforms = pkgs.lib.platforms.linux;
} ''
  mkdir -p "$out/bin" "$out/libexec/reverie"
  install -m444 ${src}/python/reverie/cleanup/collector.py "$out/libexec/reverie/collector.py"
  install -m444 ${src}/python/reverie/cleanup/collector_state.py "$out/libexec/reverie/collector_state.py"
  install -m444 ${src}/python/reverie/cleanup/collector_user.py "$out/libexec/reverie/collector_user.py"
  cat > "$out/libexec/reverie/collector-runtime.json" <<'JSON'
  {"python":"${pkgs.python3}/bin/python3","systemctl":"${pkgs.systemd}/bin/systemctl"}
  JSON
  printf '%s  %s\n' \
    '113dba6a1e0094b0431eda05cf1ba3f4f6b0bd29bad151f5cc40d512ff66b113' "$out/libexec/reverie/collector.py" \
    'cf76217a3176ed443b6057b1cfd7b632b4e4b264c9f8e676264d743651d15899' "$out/libexec/reverie/collector_state.py" \
    'cc04f1e1f34719244cea905c6018f8c5e352bad2b739bfcb2ae8ab27ebc9625f' "$out/libexec/reverie/collector_user.py" \
    | sha256sum --check --status
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-collect" \
    --add-flags "-I -B $out/libexec/reverie/collector.py"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-collect-state" \
    --add-flags "-I -B $out/libexec/reverie/collector_state.py"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-observations" \
    --add-flags "-I -B $out/libexec/reverie/collector_user.py"
  ln -s ${historyCli}/bin/reverie-resource-history "$out/bin/reverie-resource-history"
  ln -s ${historyCli}/bin/reverie-prune-receipts "$out/bin/reverie-prune-receipts"
  "$out/bin/reverie-collect" --help > /dev/null
  "$out/bin/reverie-prune-receipts" --help > /dev/null
  "$out/bin/reverie-collect-state" --help > /dev/null
  "$out/bin/reverie-observations" --help > /dev/null
  "$out/bin/reverie-resource-history" --help > /dev/null
  cp "$out/libexec/reverie/collector.py" reverie_collect.py
  cp ${src}/tests/cleanup_sources/test_reverie_collect.py test_reverie_collect.py
  python3 -I -B -X dev -W error::ResourceWarning test_reverie_collect.py
  chmod -R a-w "$out"
''
