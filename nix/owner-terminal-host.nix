{ pkgs, src, console, memory, memoryPackage, entrypoint, resourceReplacement ? false, serviceAuthConfig ? null }:
# Optional package/image input only. No automatic install/start or CLI replacement.
# A composed resource actor may opt into its separately reviewed web flag at build
# time; no runtime, browser or worker field selects commands or startup arguments.
assert builtins.isBool resourceReplacement;
let
  auth = import ./service-auth-config.nix { inherit (pkgs) lib; } serviceAuthConfig;
  toolkit = import ./human-terminal-toolkit.nix { inherit pkgs src; };
  nodeInvocation = "${pkgs.nodejs_22}/bin/node";
  pythonInvocation = "${memory}/bin/python3";
  wrapper = "${console}/lib/reverie/scripts/owner-terminal-start.mjs";
  webArgs = [ "web" "--host" "0.0.0.0" "--port" "3000" ]
    ++ pkgs.lib.optionals (auth != null) [ "--service-auth-config" auth ]
    ++ pkgs.lib.optionals resourceReplacement [ "--resource-replacement" ];
  nodeArgv = [ nodeInvocation wrapper ] ++ webArgs;
  host = pkgs.writeShellApplication {
    name = "reverie-owner-terminal-host";
    runtimeInputs = [ memory pkgs.docker-client ];
    text = ''
      unset PYTHONPATH PYTHONHOME NODE_OPTIONS NODE_PATH LD_PRELOAD LD_AUDIT
      exec ${pythonInvocation} -I -B ${src}/scripts/reverie-owner-terminal-host "$@"
    '';
  };
  website = pkgs.writeTextFile {
    name = "reverie-owner-terminal-website";
    # Keep basename reverie for the unchanged normal entrypoint web checks,
    # but use libexec so this optional package never replaces the normal CLI.
    destination = "/libexec/reverie";
    executable = true;
    passthru = { inherit webArgs; };
    text = ''#!${pythonInvocation} -I
import sys
from reverie.owner_terminal_bootstrap import exec_backend
if sys.argv[1:] != ${builtins.toJSON webArgs}:
    raise SystemExit("Fixed optional website arguments required")
exec_backend("${nodeInvocation}", tuple(${builtins.toJSON nodeArgv}))
'';
  };
  programInput = pkgs.writeText "owner-terminal-website-program-input.json" (builtins.toJSON {
    version = 1; purpose = "owner-terminal-website-program-v1";
    inherit nodeInvocation;
    nodeWrapper = wrapper;
    applicationEntry = "${console}/lib/reverie/dist/index.js";
    argvPrefix = nodeArgv;
    startupPython = {
      invocation = pythonInvocation;
      executable = pkgs.python3.interpreter;
      entry = "${website}/libexec/reverie";
      bootstrapModule = "${memoryPackage}/${pkgs.python3.sitePackages}/reverie/owner_terminal_bootstrap.py";
      packageInit = "${memoryPackage}/${pkgs.python3.sitePackages}/reverie/__init__.py";
      argvPrefix = [ pythonInvocation "-I" "${website}/libexec/reverie" ] ++ webArgs;
    };
    normalEntrypoint = "${entrypoint}";
    files = [
      "${website}/libexec/reverie"
      "${memoryPackage}/${pkgs.python3.sitePackages}/reverie/__init__.py"
      "${memoryPackage}/${pkgs.python3.sitePackages}/reverie/owner_terminal_bootstrap.py"
      wrapper "${console}/lib/reverie/scripts/connect-owner-terminal.mjs"
      "${console}/lib/reverie/dist/owner-terminal-runtime.js"
      "${console}/lib/reverie/dist/owner-laptop-terminal-authority.js"
      "${console}/lib/reverie/dist/owner-ledger-bridge.js"
      "${console}/lib/reverie/dist/index.js" "${entrypoint}"
    ];
  });
  websiteManifest = pkgs.runCommand "reverie-owner-terminal-website-manifest" {
    nativeBuildInputs = [ pkgs.python3 ];
  } ''
    mkdir -p "$out/share/reverie-owner-terminal"
    python3 - ${programInput} "$out/share/reverie-owner-terminal/website-program.json" <<'PY'
import hashlib,json,pathlib,sys
value=json.loads(pathlib.Path(sys.argv[1]).read_bytes())
node=pathlib.Path(value['nodeInvocation']).resolve(strict=True)
python=pathlib.Path(value['startupPython']['executable']).resolve(strict=True)
invocation=pathlib.Path(value['startupPython']['invocation']).resolve(strict=True)
files=value.pop('files')+[str(node),str(python),str(invocation)]
code={}
total=0
for spelling in files:
    path=pathlib.Path(spelling).resolve(strict=True)
    assert str(path).startswith('/nix/store/') and path.is_file()
    size=path.stat().st_size
    assert size<=256*1024**2
    total+=size
    assert total<=512*1024**2
    code[str(path)]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'bytes':size}
for executable in (node,python,invocation):
    with executable.open('rb') as stream:assert stream.read(4)==b'\x7fELF'
value['nodeExecutable']=str(node)
value['startupPython']['executable']=str(python)
value['codeFiles']=code
pathlib.Path(sys.argv[2]).write_text(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n')
PY
  '';
in pkgs.symlinkJoin {
  name = "reverie-owner-terminal-host";
  paths = [ host website websiteManifest toolkit ];
  passthru = { inherit host website websiteManifest toolkit; };
}
