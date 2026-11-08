# Static top-level checker: inherited LD_PRELOAD cannot affect code before main.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [
      "reverie-perf-check" "reverie-core" "reverie-contracts"
      "reverie-host" "reverie-store" "reverie-http"
      "reverie-diagnostics" "reverie-python-regex"
    ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
in pkgs.pkgsStatic.rustPlatform.buildRustPackage {
  pname = "reverie-perf-guest-check";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = [ "-p" "reverie-perf-check" ];
  # Qualify real ancillary/process ownership under the shipped static ABI.
  doCheck = true;
  cargoTestFlags = [ "-p" "reverie-host" "--lib" "native::owned_process::tests" ];
  nativeCheckInputs = [ pkgs.rustc ];
  preCheck = ''
    export PATH="${pkgs.stdenv.cc}/bin:$PATH"
    unset NIX_CFLAGS_COMPILE NIX_LDFLAGS
  '';
  meta = {
    description = "Static fixed-purpose guest perf checker (unselected candidate)";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
