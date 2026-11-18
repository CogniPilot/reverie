# Optional GPU/model overlay. The base image and selected CUDA runtime are
# immutable build inputs; this image needs no host Reverie packages or services.
{ pkgs, src, baseImage, baseConfig, containerRuntime, entrypoint, inferenceRuntime }:
let
  modelRelaySource = import ./model-relay-source.nix { inherit pkgs src; };
  tailscale = import ./tailscale-serve.nix { inherit pkgs; };
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
  contents = [ containerRuntime inferenceRuntime tailscale.package ];
  extraCommands = ''
    mkdir -p usr/local/bin
    ln -s ${entrypoint} usr/local/bin/reverie-start
    ${tailscale.install}
  '';
  config = baseConfig // {
    Labels = (baseConfig.Labels or {}) // { "org.reverie.tailscale" = "1"; };
    Entrypoint = [
      "/bin/tini" "-g" "-s" "--"
      "${containerRuntime}/bin/reverie-container-runtime"
      "/usr/local/bin/reverie-start"
    ];
    Env = (baseConfig.Env or []) ++ [
      "REVERIE_LLAMA_SERVER=${inferenceRuntime}/bin/llama-server"
      "REVERIE_GPU_PUBLISHER=${containerRuntime}/bin/reverie-gpu-publisher"
      "REVERIE_MODEL_RELAY=${pkgs.nodejs_22}/bin/node"
      "REVERIE_MODEL_RELAY_SCRIPT=${modelRelaySource}"
    ];
  };
}
