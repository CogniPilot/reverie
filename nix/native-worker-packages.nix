# Build-only employee image inputs. Keep this path for existing pool provenance.
{ pkgs, src }:
rec {
  nativeWorkerPoolAnchorImage = import ./worker-pool-anchor-image.nix { inherit pkgs; };
  nativeWorkerResourceController = import ./worker-resource-controller.nix { inherit pkgs src; };
  nativeWorkerResourceControllerImage = import ./worker-resource-controller-image.nix {
    inherit pkgs;
    controller = nativeWorkerResourceController;
  };
  nativeWorkerPoolImageInputs = import ./worker-pool-image-inputs.nix {
    inherit pkgs src;
    controllerImage = nativeWorkerResourceControllerImage;
    controllerProgram = nativeWorkerResourceController;
    anchorImage = nativeWorkerPoolAnchorImage;
  };
  nativePerfGuestCapsule = import ./perf-guest-capsule.nix { inherit pkgs src; };
  workerDockerSeccomp = import ./worker-docker-profile.nix { inherit pkgs src; };
  workerTaskPerfPolicy = import ./worker-perf-profile.nix {
    inherit pkgs src;
    baseProfile = workerDockerSeccomp;
  };
  workerTaskPerfPolicyV2 = import ./worker-perf-profile.nix {
    inherit pkgs src;
    baseProfile = workerDockerSeccomp;
    policy = "task-v2";
  };
}
