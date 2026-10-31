# The host and its owner-local tools need the same genuine task-perf artifact.
# Keep this independent of the website/resume program to avoid a manifest cycle.
{ pkgs, src }:
let
  baseProfile = import ./worker-docker-profile.nix { inherit pkgs; };
  perfPolicy = import ./worker-perf-profile.nix { inherit pkgs src baseProfile; };
in pkgs.runCommand "reverie-owner-terminal-python-source" {
  nativeBuildInputs = [ pkgs.python3 ];
} ''
  mkdir -p "$out/scripts" "$out/apps/host"
  cp -R ${src}/python "$out/python"
  cp ${src}/scripts/reverie-owner-terminal-host ${src}/scripts/owner-terminal-lifecycle.mjs "$out/scripts/"
  cp ${src}/apps/host/website-update.py "$out/apps/host/"
  chmod u+w "$out/python/reverie"
  cp ${perfPolicy}/share/reverie/worker-perf-profile.json \
    "$out/python/reverie/worker-perf-profile.json"
  python3 - "$out" <<'PY'
  import pathlib,sys
  root=pathlib.Path(sys.argv[1]);files=[p for p in root.rglob('*') if p.is_file()]
  assert not any(p.is_symlink() for p in root.rglob('*'))
  assert len(files)<=4096 and sum(p.stat().st_size for p in files)<=64*1024**2
  assert all(p.stat().st_size<=16*1024**2 for p in files)
  PY
''
