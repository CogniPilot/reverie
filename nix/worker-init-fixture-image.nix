# Explicit init-only fixture image data. No public/default deployment selection.
# capsule is the independently qualified immutable perf-capsule-v2 build output.
{ pkgs, capsule }:
pkgs.dockerTools.buildLayeredImage {
  name = "reverie-worker-init-fixture";
  tag = "capsule-v2-regular-r2";
  created = "1970-01-01T00:00:01Z";
  # buildEnv contents turns leaf files into links into /nix/store. Copy the
  # actual sealed layout in the final image layer, as the product image does.
  contents = [];
  fakeRootCommands = ''
    mkdir -p opt/reverie
    cp -r ${capsule}/opt/reverie/perf opt/reverie/perf
    chmod -R a-w opt/reverie/perf
    for directory in opt opt/reverie opt/reverie/perf opt/reverie/perf/bin; do
      test -d "$directory" && test ! -L "$directory"
    done
    test -f opt/reverie/perf/bin/reverie-worker-init
    test ! -L opt/reverie/perf/bin/reverie-worker-init
  '';
  config = {
    User = "1000:100";
    WorkingDir = "/tmp";
    Entrypoint = [ "/opt/reverie/perf/bin/reverie-worker-init" ];
    Cmd = [];
    Env = [ "PATH=" ];
  };
}
