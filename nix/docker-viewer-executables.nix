# Immutable packaging ABI for read-only viewer transport custody. This is not
# instance configuration and never selects a provider or an execution request.
{ pkgs }:
{
  version = 1;
  purpose = "reverie-docker-viewer-executables-v1";
  executables = {
    "/bin/docker" = {
      entry = "${pkgs.docker-client}/bin/docker";
      executable = "${pkgs.docker-client}/libexec/docker/docker";
      # The pinned makeBinaryWrapper defaults argv[0] to its executable.
      argv0 = "${pkgs.docker-client}/libexec/docker/docker";
    };
    "/bin/bash" = {
      entry = "${pkgs.bashInteractive}/bin/bash";
      executable = "${pkgs.bashInteractive}/bin/bash";
      argv0 = "/bin/bash";
    };
    "/bin/tmux" = {
      entry = "${pkgs.tmux}/bin/tmux";
      executable = "${pkgs.tmux}/bin/tmux";
      argv0 = "/bin/tmux";
    };
  };
}
