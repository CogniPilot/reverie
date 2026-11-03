# Fixed owner-local lifecycle tools. Private installation choices remain data;
# no runtime/image/program selector is accepted from a request or calling shell.
{ pkgs, src, memory, profile, websiteManifest, imageProvenance, toolkit }:
assert builtins.elem profile [ "terminal" "resource-terminal" ];
let
  pythonSource = import ./owner-terminal-python-source.nix { inherit pkgs src; };
  input = pkgs.writeText "reverie-owner-terminal-lifecycle-input.json" (builtins.toJSON {
    version = 1;
    purpose = "owner-terminal-lifecycle-runtime-v1";
    inherit profile;
    hostProgram = {
      invocation = "${memory}/bin/python3";
      executable = pkgs.python3.interpreter;
      entry = "${pythonSource}/scripts/reverie-owner-terminal-host";
    };
    systemctl = "${pkgs.lib.getBin pkgs.systemd}/bin/systemctl";
    engineProgram = "${pkgs.docker-client}/bin/docker";
    websiteProgram = "${websiteManifest}/share/reverie-owner-terminal/website-program.json";
    imageProvenance = "${imageProvenance}/share/reverie/website-image.json";
    toolkitManifest = "${toolkit}/share/reverie-human-terminal/manifest.json";
  });
in pkgs.runCommand "reverie-owner-terminal-lifecycle-${profile}" {
  nativeBuildInputs = [ pkgs.python3 ];
  meta.mainProgram = "reverie-owner-terminal-lifecycle";
} ''
  mkdir -p "$out/bin" "$out/libexec" "$out/share/reverie-owner-terminal"
  python3 - ${input} "$out" <<'PY'
import hashlib,json,pathlib,sys
value=json.loads(pathlib.Path(sys.argv[1]).read_bytes())
out=pathlib.Path(sys.argv[2])
host=value['hostProgram']
python=pathlib.Path(host['executable']).resolve(strict=True)
invocation=pathlib.Path(host['invocation']).resolve(strict=True)
entry=pathlib.Path(host['entry']).resolve(strict=True)
for path in (python,invocation,entry):
    assert str(path).startswith('/nix/store/') and path.is_file()
for path in (python,invocation):
    with path.open('rb') as stream:assert stream.read(4)==b'\x7fELF'
value['hostProgram']={'executable':str(python),
    'argvPrefix':[host['invocation'],'-I','-B',str(entry)]}
for name in ('systemctl','engineProgram','websiteProgram','imageProvenance','toolkitManifest'):
    path=pathlib.Path(value[name]).resolve(strict=True)
    assert str(path).startswith('/nix/store/') and path.is_file()
    assert path.stat().st_size<=256*1024**2
    if name in ('systemctl','engineProgram'):
        with path.open('rb') as stream:assert stream.read(4)==b'\x7fELF'
    value[name]={'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
manifest=out/'share/reverie-owner-terminal/lifecycle-runtime.json'
raw=(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
assert len(raw)<=65536
manifest.write_bytes(raw)
pair={'path':str(manifest),'sha256':hashlib.sha256(raw).hexdigest()}
script=out/'libexec/owner-terminal-lifecycle.py'
script.write_text('import sys\n'
    'sys.path.insert(0,${builtins.toJSON "${pythonSource}/python"})\n'
    'from reverie.owner_terminal_lifecycle import main\n'
    'raise SystemExit(main(runtime_manifest='+repr(pair)+'))\n')
launcher=out/'bin/reverie-owner-terminal-lifecycle'
launcher.write_text('#!${pkgs.bash}/bin/bash\n'
    'exec ${memory}/bin/python3 -I -B '+str(script)+' "$@"\n')
launcher.chmod(0o755)
PY
''
