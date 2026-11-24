# The one owner of how first-party builds treat their test suites.
#
# runChecks = true keeps each suite inside its artefact build. A Rust suite runs
# every test binary even after one fails (cargo's --no-fail-fast), so one build
# log names every failing binary instead of only the first. The console's own
# check phase does the same for its batches (nix/package.nix).
#
# runChecks = false hands first-party recipes builders that drop the test phase
# and everything only that phase needs. The compile, bundle and install steps
# are unchanged. Removing the attributes, and not only clearing doCheck, also
# removes the test fixtures from the derivation's inputs, so an edit that only
# changes a fixture no longer rebuilds the artefact.
#
# Only the builders named here change, by a shallow update of the package set.
# This is not an overlay: nixpkgs' own packages keep their upstream builders and
# stay substitutable. A recipe using any other builder is left as written.
#
# The two variants are different derivations with different store paths, so an
# image built from one never has the image ID of the other. The same suites run
# from the checked set; see checks.deployPathSuites in flake.nix.
{ pkgs, runChecks ? true }:
assert builtins.isBool runChecks;
let
  checkOnly = [
    "checkPhase" "preCheck" "postCheck" "checkInputs" "nativeCheckInputs"
    "checkFlags" "checkTarget" "cargoTestFlags"
    "installCheckPhase" "preInstallCheck" "postInstallCheck"
    "installCheckInputs" "nativeInstallCheckInputs"
  ];
  withoutChecks = args: builtins.removeAttrs args checkOnly // {
    doCheck = false;
    doInstallCheck = false;
  };
  # A recipe that already disables its suite gains nothing to report.
  everyTestBinary = args: if !(args.doCheck or true) then args else args // {
    cargoTestFlags = [ "--no-fail-fast" ] ++ (args.cargoTestFlags or []);
  };
  apply = change: builder: args: builder
    (if builtins.isFunction args then final: change (args final) else change args);
  rust = platform: platform // {
    buildRustPackage = apply (if runChecks then everyTestBinary else withoutChecks)
      platform.buildRustPackage;
  };
in pkgs // {
  rustPlatform = rust pkgs.rustPlatform;
  pkgsStatic = pkgs.pkgsStatic // { rustPlatform = rust pkgs.pkgsStatic.rustPlatform; };
} // pkgs.lib.optionalAttrs (!runChecks) {
  buildNpmPackage = apply withoutChecks pkgs.buildNpmPackage;
}
