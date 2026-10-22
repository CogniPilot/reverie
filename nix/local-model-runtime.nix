# Built by the host launcher for the selected physical GPU, independently of the agent image.
{ nixpkgs, system, capability ? "" }:
let
  pkgs = import (builtins.toPath nixpkgs) {
    inherit system;
    config = {
      allowUnfree = true;
      cudaSupport = capability != "";
      cudaCapabilities = if capability == "" then [] else [ capability ];
    };
  };
in pkgs.llama-cpp.override {
  cudaSupport = capability != "";
  vulkanSupport = false;
  rocmSupport = false;
  metalSupport = false;
}
