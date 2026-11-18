{ pkgs, src }:
# The console-free tools, built in one cargo invocation so reverie-host and its closure
# compile once for all of them. Each tool's own nix file links its binary from here. They resolve
# the same features alone as together: reverie-host carries the lease tool's nix "signal", so the
# other tools now also compile nix's signal and process modules.
let
  # Only these packages' crate closure, so an unrelated change keeps the cached build.
  workspace = import ./rust-workspace-source.nix {
    inherit pkgs src;
    members = [
      "reverie-contracts" "reverie-core" "reverie-diagnostics" "reverie-host" "reverie-worker-client" "reverie-http" "reverie-python-regex" "reverie-store"
      "reverie-admin-memory" "reverie-deployment" "reverie-lease-cli" "reverie-nix-store-prepare" "reverie-worker-child" "reverie-application"
    ];
    vendors = [ "rustpython-sre-engine" "rustpython-wtf8" ];
  };
  packages = [ "reverie-admin-memory" "reverie-deployment" "reverie-lease-cli" "reverie-nix-store-prepare" "reverie-worker-child" ];
  each = flag: builtins.concatMap (package: [ flag package ]) packages;
in
pkgs.rustPlatform.buildRustPackage {
  pname = "reverie-host-tools";
  version = "0.1.0";
  src = workspace.source;
  cargoLock.lockFile = workspace.lockFile;
  cargoBuildFlags = each "-p";
  cargoTestFlags = each "-p" ++ [ "--features" "reverie-admin-memory/test-fixtures" ];
  # These fixed helper paths are compiled into their consumers.
  REVERIE_FIXED_HANDS_SEARCH_CURL = "${pkgs.curl}/bin/curl";
  nativeCheckInputs = [ pkgs.gnutar pkgs.attr pkgs.acl pkgs.bubblewrap ];
  NIX_REVERIE_TEST_DEPLOYMENT_BWRAP = "${pkgs.bubblewrap}/bin/bwrap";
  REVERIE_DEPLOYMENT_TAR = "${pkgs.gnutar}/bin/tar";
  REVERIE_DEPLOYMENT_GETFATTR = "${pkgs.attr}/bin/getfattr";
  REVERIE_DEPLOYMENT_GETFACL = "${pkgs.acl}/bin/getfacl";
  REVERIE_DEPLOYMENT_COPY = "${pkgs.coreutils}/bin/cp";
  doCheck = true;
  meta = {
    description = "Deployment, lease, worker Nix store bootstrap and worker child tools from one host build";
    license = pkgs.lib.licenses.mit;
    platforms = pkgs.lib.platforms.linux;
  };
}
