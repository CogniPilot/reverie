# Generic browser/dispatch tools only. Matching NVIDIA libraries and devices are
# injected by an owner-reviewed host CDI spec, never a second driver in the image.
{ pkgs, src }:
let
  probeSource = pkgs.writeText "reverie-browser-gpu-probe.mjs"
    (builtins.readFile (src + "/scripts/browser-gpu-probe.mjs"));
  probe = pkgs.writeShellApplication {
    name = "reverie-browser-gpu-probe";
    runtimeInputs = [ pkgs.nodejs_22 ];
    text = ''exec node ${probeSource} "$@"'';
  };
in pkgs.buildEnv {
  name = "reverie-browser-runtime";
  paths = [ pkgs.chromium pkgs.vulkan-tools pkgs.libglvnd pkgs.vulkan-loader probe ];
  pathsToLink = [ "/bin" "/share" "/lib" ];
}
