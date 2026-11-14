# Build-only employee image inputs. No host broker, unit, installer or viewer selection.
{ pkgs, src, console }:
let
  inputs = import ./native-worker-packages.nix { inherit pkgs src console; };
in {
  inherit (inputs)
    nativeWorkerPoolAnchorImage nativeWorkerResourceController nativeWorkerResourceControllerImage
    nativeWorkerPoolImageInputs nativePerfGuestCapsule workerDockerSeccomp
    workerTaskPerfPolicy workerTaskPerfPolicyV2;
}
