# Trusted build-time composition of one immutable runtime source and package set.
# Disabling checks changes build policy, never the selected program sources.
{ pkgs, src, artifactSource ? src, runChecks ? true }:
let
  noChecks = { doCheck = false; doInstallCheck = false; };
  python = pkgs.python3.override {
    packageOverrides = final: previous: {
      buildPythonPackage = arguments: previous.buildPythonPackage (
        if builtins.isAttrs arguments && (arguments.pname or "") == "reverie-memory"
        then arguments // noChecks
        else arguments
      );
    };
  };
  runtimePkgs = if runChecks then pkgs else pkgs // {
    python3 = python;
    python3Packages = python.pkgs;
  };
  packages = import (src + "/nix/package.nix") { pkgs = runtimePkgs; inherit src; };
  artifacts = import (artifactSource + "/nix/policy-artifacts.nix") {
    pkgs = runtimePkgs; src = artifactSource;
  };
in assert builtins.isBool runChecks;
packages // {
  laptopTools = if runChecks then packages.laptopTools
    else packages.laptopTools.overrideAttrs (_: noChecks);
  policyArtifacts = if runChecks then artifacts else artifacts.overrideAttrs (_: noChecks);
  humanTerminalToolkit = import (src + "/nix/human-terminal-toolkit.nix") {
    pkgs = runtimePkgs; inherit src;
  };
}
