# Optional GPU/model overlay. The base image and selected CUDA runtime are
# immutable build inputs; this image needs no host Reverie packages or services.
{ pkgs, src, baseImage, baseConfig, containerRuntime, gpuPublisher, inferenceRuntime }:
let
  entrypoint = pkgs.writeShellScript "reverie-container-start" (builtins.readFile (src + "/docker/entrypoint.sh"));
in
assert builtins.isAttrs baseConfig && builtins.isList baseConfig.Entrypoint;
pkgs.dockerTools.buildLayeredImage {
  name = "reverie-gpu";
  tag = "latest";
  maxLayers = 125;
  fromImage = baseImage;
  contents = [ containerRuntime gpuPublisher inferenceRuntime ];
  extraCommands = ''
    mkdir -p usr/local/bin
    ln -s ${entrypoint} usr/local/bin/reverie-start
  '';
  config = baseConfig // {
    Entrypoint = [
      "/bin/tini" "-g" "-s" "--"
      "${containerRuntime}/bin/reverie-container-runtime"
      "/usr/local/bin/reverie-start"
    ];
    Env = (baseConfig.Env or []) ++ [
      "REVERIE_LLAMA_SERVER=${inferenceRuntime}/bin/llama-server"
      "REVERIE_GPU_PUBLISHER=${gpuPublisher}/bin/reverie-gpu-publisher"
      "REVERIE_MODEL_RELAY=${pkgs.nodejs_22}/bin/node"
      "REVERIE_MODEL_RELAY_SCRIPT=${src}/apps/host/model-relay.mjs"
    ];
  };
}
