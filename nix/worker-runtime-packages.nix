# Trusted build-time composition of one immutable runtime source and package set.
# Disabling checks changes build policy, never the selected program sources.
{ pkgs, src, artifactSource ? src, runChecks ? true }:
let
  noChecks = { doCheck = false; doInstallCheck = false; };
  packages = import (src + "/nix/package.nix") { inherit pkgs src; };
  artifacts = import (artifactSource + "/nix/policy-artifacts.nix") {
    inherit pkgs; src = artifactSource;
  };
  selectedArtifacts = if runChecks then artifacts else artifacts.overrideAttrs (_: noChecks);
  toolkitRecipe = import (artifactSource + "/nix/human-terminal-toolkit.nix");
  toolkitInputs = { inherit pkgs src; }
    // pkgs.lib.optionalAttrs ((builtins.functionArgs toolkitRecipe) ? artifacts) {
      artifacts = selectedArtifacts;
    };
in assert builtins.isBool runChecks;
packages // {
  laptopTools = if runChecks then packages.laptopTools
    else packages.laptopTools.overrideAttrs (_: noChecks);
  policyArtifacts = selectedArtifacts;
  humanTerminalToolkit = toolkitRecipe toolkitInputs;
}
