# Optional GPU/model overlay. The base image and selected CUDA runtime are
# immutable build inputs; this image needs no host Reverie packages or services.
{ pkgs, src, baseImage, baseConfig, containerRuntime, gpuTelemetry, inferenceRuntime }:
let
  entrypoint = pkgs.writeShellScript "reverie-container-start" (builtins.readFile (src + "/docker/entrypoint.sh"));
in
assert builtins.isAttrs baseConfig && builtins.isList baseConfig.Entrypoint;
pkgs.dockerTools.buildLayeredImage rec {
  name = "reverie-gpu";
  tag = "latest";
  # The boxed website adds its customisation layer and dockerTools requires at
  # least one contents layer even when contents is empty. Reserve both slots.
  maxLayers = 125 - 2;
  fromImage = baseImage;
  passthru.reverieConfig = config;
  contents = [ containerRuntime gpuTelemetry inferenceRuntime ];
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
      "REVERIE_GPU_PUBLISHER=${gpuTelemetry}/bin/reverie-container-gpu-telemetry"
      "REVERIE_MODEL_RELAY=${pkgs.nodejs_22}/bin/node"
      "REVERIE_MODEL_RELAY_SCRIPT=${src}/apps/host/model-relay.mjs"
    ];
  };
}
