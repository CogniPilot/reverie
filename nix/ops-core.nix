# Fixed ordinary-owner executor; this package installs no service, grant or policy.
{ pkgs, src }:
pkgs.runCommand "reverie-ops-core" { nativeBuildInputs = [ pkgs.makeWrapper pkgs.python3 ]; meta.platforms = pkgs.lib.platforms.linux; } ''
  mkdir -p "$out/lib/python/reverie" "$out/libexec" "$out/bin"
  cp ${src}/python/reverie/ops_*.py "$out/lib/python/reverie/"
  cp ${src}/python/reverie/worker_storage.py "$out/lib/python/reverie/"
  cp ${src}/python/reverie/ops-classifier-pin.json "$out/lib/python/reverie/"
  cp ${src}/python/reverie/ops-core.schema.json "$out/lib/python/reverie/"
  touch "$out/lib/python/reverie/__init__.py"
  cat > "$out/libexec/ops-bootstrap.py" <<'PY'
import pathlib,runpy,sys
module=sys.argv.pop(1)
if module not in ('reverie.ops_service','reverie.ops_installer','reverie.ops_cli'):raise SystemExit(2)
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'lib/python'))
runpy.run_module(module,run_name='__main__')
PY
  ${pkgs.python3}/bin/python3 -I -B - "$out" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);p=root/'lib/python/reverie'
manifest={'version':1,'systemctlExecutable':'${pkgs.systemd}/bin/systemctl','sources':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in p.glob('*.py')}}
(root/'manifest.json').write_text(json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\n')
PY
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-ops-daemon" --add-flags "-I -B $out/libexec/ops-bootstrap.py reverie.ops_service"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-ops" --add-flags "-I -B $out/libexec/ops-bootstrap.py reverie.ops_cli"
  makeWrapper ${pkgs.python3}/bin/python3 "$out/bin/reverie-ops-service" --add-flags "-I -B $out/libexec/ops-bootstrap.py reverie.ops_installer" \
    --set REVERIE_OPS_LAUNCHER "$out/bin/reverie-ops-daemon" --set REVERIE_OPS_MANIFEST "$out/manifest.json" --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.systemd pkgs.nix ]}
  "$out/bin/reverie-ops-daemon" --help >/dev/null
  "$out/bin/reverie-ops-service" --help >/dev/null
  "$out/bin/reverie-ops" --help >/dev/null
  PYTHONPATH=${src}/python:${src} OPS_TEST_PACKAGE="$out" ${pkgs.python3}/bin/python3 -B -m unittest discover -s ${src}/tests -p "test_ops_*.py"
  chmod -R a-w "$out"
''
