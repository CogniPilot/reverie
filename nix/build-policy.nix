# The one owner of whether first-party artefact builds run their test suites.
#
# runChecks = true returns pkgs untouched: every derivation is the one built
# before this knob existed, with its tests inside the build.
#
# runChecks = false hands first-party recipes builders that drop the test phase
# and everything only that phase needs. The compile, bundle and install steps
# are unchanged. Removing the attributes, and not only clearing doCheck, also
# removes the test fixtures from the derivation's inputs, so an edit that only
# changes a fixture no longer rebuilds the artefact.
#
# Only the builders named here change, by a shallow update of the package set.
# This is not an overlay: nixpkgs' own packages keep their upstream builders and
# stay substitutable. A recipe using any other builder keeps its tests.
#
# The two variants are different derivations with different store paths, so an
# image built from one never has the image ID of the other. The same suites run
# from the checked set; see checks.deployPathSuites in flake.nix.
{ pkgs, runChecks ? true }:
assert builtins.isBool runChecks;
if runChecks then pkgs else
let
  checkOnly = [
    "checkPhase" "preCheck" "postCheck" "checkInputs" "nativeCheckInputs"
    "checkFlags" "checkTarget" "cargoTestFlags"
    "installCheckPhase" "preInstallCheck" "postInstallCheck"
    "installCheckInputs" "nativeInstallCheckInputs"
  ];
  strip = args: builtins.removeAttrs args checkOnly // {
    doCheck = false;
    doInstallCheck = false;
  };
  withoutChecks = builder: args: builder
    (if builtins.isFunction args then final: strip (args final) else strip args);
  rust = platform: platform // {
    buildRustPackage = withoutChecks platform.buildRustPackage;
  };
in pkgs // {
  buildNpmPackage = withoutChecks pkgs.buildNpmPackage;
  rustPlatform = rust pkgs.rustPlatform;
  pkgsStatic = pkgs.pkgsStatic // { rustPlatform = rust pkgs.pkgsStatic.rustPlatform; };
}
