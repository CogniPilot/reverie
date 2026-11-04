{ pkgs, src, memory, lifecycle, workerUnit, workerBrokerSource }:
# Optional owner-local initial H website activation. Defaults do not depend on
# this package, and no runtime flag can select a program or lifecycle manifest.
let
  pythonSource = import ./owner-terminal-python-source.nix { inherit pkgs src; };
  runtime = "${lifecycle}/share/reverie-owner-terminal/lifecycle-runtime.json";
  binding = {
    unit = "${workerUnit}/share/systemd/user/reverie-worker-broker.service";
    python = "${pkgs.python3}/bin/python3";
    entry = "${workerBrokerSource}/python/reverie/worker.py";
  };
in pkgs.runCommand "reverie-owner-terminal-website" {
  nativeBuildInputs = [ pkgs.python3 ];
  meta.mainProgram = "reverie-owner-terminal-website";
} ''
  mkdir -p "$out/bin" "$out/libexec" "$out/share/reverie-owner-terminal"
  python3 - ${runtime} "$out" <<'PY'
import hashlib,json,pathlib,sys
runtime=pathlib.Path(sys.argv[1]);raw=runtime.read_bytes()
value=json.loads(raw)
assert value['purpose']=='owner-terminal-lifecycle-runtime-v1' and value['profile']=='terminal'
pair={'path':str(runtime),'sha256':hashlib.sha256(raw).hexdigest()}
out=pathlib.Path(sys.argv[2]);script=out/'libexec/owner-terminal-website.py'
backend=pathlib.Path(${builtins.toJSON "${pythonSource}"}).resolve(strict=True)
adapter=pathlib.Path(${builtins.toJSON "${pythonSource}"}).resolve(strict=True)
entry=(backend/'scripts/reverie-owner-terminal-host').resolve(strict=True)
assert value['hostProgram']['argvPrefix'][3]==str(entry)
assert (backend/'python/reverie/__init__.py').is_file()
files={}
for name in ('python/reverie/owner_terminal_website.py','apps/host/website-update.py','scripts/owner-terminal-lifecycle.mjs'):
    path=(adapter/name).resolve(strict=True)
    files[name]={'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
witness={'version':1,'purpose':'owner-terminal-website-source-pair-v1','nativeSource':str(backend),
         'adapterSource':str(adapter),'runtimeManifest':pair,'nativeHostEntry':str(entry),'adapterFiles':files}
(out/'share/reverie-owner-terminal/website-adapter-pair.json').write_text(json.dumps(witness,sort_keys=True)+'\n')
script.write_text('import sys\n'
    'sys.path.insert(0,${builtins.toJSON "${pythonSource}/python"})\n'
    'from reverie.owner_terminal_website import main\n'
    'raise SystemExit(main(runtime_manifest='+repr(pair)+',service_binding='+repr(${builtins.toJSON binding})+'))\n')
launcher=out/'bin/reverie-owner-terminal-website'
launcher.write_text('#!${pkgs.bash}/bin/bash\n'
    'unset LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT PYTHONPATH PYTHONHOME NODE_OPTIONS NODE_PATH\n'
    'export PATH=${pkgs.lib.getBin pkgs.systemd}/bin:${pkgs.coreutils}/bin\n'
    'exec ${memory}/bin/python3 -I -B '+str(script)+' "$@"\n')
launcher.chmod(0o755)
PY
''
