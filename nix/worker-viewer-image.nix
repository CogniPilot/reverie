# The standalone viewer uses its packaged Rust broker and fixed engine client.
# Production configuration, current company data and its private Unix socket
# directory are selected by the owner as separate runtime mounts.
{ pkgs, broker, version ? "native-v1", revision ? null }:
let
  package = if builtins.isPath broker then builtins.appendContext (toString broker) {
    "${toString broker}" = { path = true; };
  } else broker;
in pkgs.dockerTools.buildLayeredImage {
  name = "reverie-worker-viewer";
  tag = version;
  created = "1970-01-01T00:00:01Z";
  contents = [ package ];
  config = {
    Entrypoint = [ "${package}/bin/reverie-worker-broker" "viewer-only" ];
    Cmd = [];
    User = "1000:100";
    WorkingDir = "/";
    Env = [
      "PATH=/bin"
      "HOME=/nonexistent"
      "LANG=C.UTF-8"
      "LC_ALL=C.UTF-8"
      "TERM=xterm-256color"
      "DOCKER_HOST=unix:///var/run/docker.sock"
    ];
    Labels = {
      "org.opencontainers.image.source" = "https://github.com/jgoppert/reverie";
      "org.opencontainers.image.version" = version;
      "reverie.purpose" = "reverie-worker-viewer-v1";
    } // pkgs.lib.optionalAttrs (revision != null) {
      "org.opencontainers.image.revision" = revision;
    };
  };
}
