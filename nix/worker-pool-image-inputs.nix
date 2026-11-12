# Only these repository-built archives enter the fixed two-role DATA producer.
# No runtime caller, JSON profile, executable or alternate archive is selected.
{ pkgs, src, controllerImage, anchorImage, controllerProgram }:
let
  artifacts = import ./policy-artifacts.nix { inherit pkgs src; };
in pkgs.runCommand "reverie-worker-pool-image-inputs" {
  meta.platforms = pkgs.lib.platforms.linux;
} ''
  mkdir -p "$out/share/reverie"
  ${artifacts}/bin/reverie-policy-artifacts pool-image-inputs \
    --system ${pkgs.lib.escapeShellArg pkgs.stdenv.hostPlatform.system} \
    --controller-archive ${pkgs.lib.escapeShellArg (toString controllerImage)} \
    --controller-program ${pkgs.lib.escapeShellArg "${controllerProgram}/bin/reverie-worker-resource-controller"} \
    --anchor-archive ${pkgs.lib.escapeShellArg (toString anchorImage)} \
    --source ${pkgs.lib.escapeShellArg (toString src)} \
    --output "$out/share/reverie/worker-pool-image-inputs.json"
  chmod 444 "$out/share/reverie/worker-pool-image-inputs.json"
''
