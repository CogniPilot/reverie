{ pkgs, src }:
pkgs.pkgsStatic.stdenv.mkDerivation {
  pname = "reverie-human-terminal-toolkit";
  version = "1";
  dontUnpack = true;
  nativeBuildInputs = [ pkgs.binutils pkgs.python3 ];
  buildPhase = ''
    $CC -std=c11 -O2 -Wall -Wextra -Werror -static -no-pie \
      ${src}/python/reverie/human_terminal_static.c -o reverie-human-shell
  '';
  installPhase = ''
    mkdir -p "$out/opt/reverie/human/bin" "$out/share/reverie-human-terminal"
    install -m555 reverie-human-shell "$out/opt/reverie/human/bin/reverie-human-shell"
    cp -L ${pkgs.pkgsStatic.bash}/bin/bash "$out/opt/reverie/human/bin/bash"
    chmod 555 "$out/opt/reverie/human/bin/bash"
    for program in "$out/opt/reverie/human/bin/"*; do
      readelf -l "$program" > program-headers
      readelf -d "$program" > dynamic-entries
      if grep -q INTERP program-headers || grep -q NEEDED dynamic-entries; then
        echo 'Human terminal toolkit must contain only static ELF programs' >&2
        exit 1
      fi
    done
    python3 - "$out" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
files={}
for path in sorted((root/'opt/reverie/human/bin').iterdir()):
    data=path.read_bytes()
    assert data[:4]==b'\x7fELF'
    files['/'+str(path.relative_to(root))]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
(root/'share/reverie-human-terminal/manifest.json').write_text(json.dumps({'version':1,'static':True,'files':files},sort_keys=True,separators=(',',':'))+'\n')
PY
  '';
  meta.platforms = pkgs.lib.platforms.linux;
}
