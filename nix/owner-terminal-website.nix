{ pkgs, src, memory, lifecycle, workerUnit, workerBrokerSource }:
# Optional owner-local initial H website activation. Defaults do not depend on
# this package, and no runtime flag can select a program or lifecycle manifest.
let
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
  mkdir -p "$out/bin" "$out/libexec"
  python3 - ${runtime} "$out" <<'PY'
import hashlib,json,pathlib,sys
runtime=pathlib.Path(sys.argv[1]);raw=runtime.read_bytes()
value=json.loads(raw)
assert value['purpose']=='owner-terminal-lifecycle-runtime-v1' and value['profile']=='terminal'
pair={'path':str(runtime),'sha256':hashlib.sha256(raw).hexdigest()}
out=pathlib.Path(sys.argv[2]);script=out/'libexec/owner-terminal-website.py'
script.write_text('import sys\n'
    'sys.path.insert(0,${builtins.toJSON "${src}/python"})\n'
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
