# Static checker and fixed PID1: neither executes code from writable /nix.
{ pkgs, src }:
let
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [
      "reverie-perf-check" "reverie-worker-init" "reverie-core" "reverie-contracts"
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
  cargoBuildFlags = [ "-p" "reverie-perf-check" "-p" "reverie-worker-init" ];
  # Qualify real ancillary/process ownership under the shipped static ABI.
  doCheck = true;
  cargoTestFlags = [ "-p" "reverie-host" "--lib" "native::owned_process::tests" ];
  nativeCheckInputs = [ pkgs.rustc ];
  preCheck = ''
    export PATH="${pkgs.stdenv.cc}/bin:$PATH"
    unset NIX_CFLAGS_COMPILE NIX_LDFLAGS
  '';
  postCheck = ''
    cargo test --locked --release --target ${pkgs.pkgsStatic.stdenv.hostPlatform.rust.rustcTarget} \
      -p reverie-worker-init
  '';
  meta = {
    description = "Static fixed-purpose guest perf checker and worker PID1 (unselected candidate)";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
