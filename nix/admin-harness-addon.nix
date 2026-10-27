{ pkgs, src }:
pkgs.runCommand "reverie-admin-harness-addon" { nativeBuildInputs = [ pkgs.python3 ]; } ''
  mkdir -p "$out/lib/harness"
  cp ${src}/python/reverie/hands/*.py "$out/lib/harness/"
  python3 -I -B "$out/lib/harness/launcher.py" --help > "$out/HELP.txt"
''
