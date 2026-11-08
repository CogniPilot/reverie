# Observation producers only; these do not grant pruning or authenticated effects.
{ pkgs, src }:
let
  # The collector, USER observations, resource history reader, state
  # initializer and prune receipts are all native.
  observationsCli = import ./observations-cli.nix { inherit pkgs src; };
in
pkgs.runCommand "reverie-cleanup-observations" {
  meta.platforms = pkgs.lib.platforms.linux;
} ''
  mkdir -p "$out/bin"
  ln -s ${observationsCli}/bin/reverie-collect "$out/bin/reverie-collect"
  ln -s ${observationsCli}/bin/reverie-prune-receipts "$out/bin/reverie-prune-receipts"
  ln -s ${observationsCli}/bin/reverie-observations "$out/bin/reverie-observations"
  ln -s ${observationsCli}/bin/reverie-collect-state "$out/bin/reverie-collect-state"
  ln -s ${observationsCli}/bin/reverie-resource-history "$out/bin/reverie-resource-history"
  "$out/bin/reverie-collect" --help > /dev/null
  "$out/bin/reverie-prune-receipts" --help > /dev/null
  "$out/bin/reverie-collect-state" --help > /dev/null
  "$out/bin/reverie-observations" --help > /dev/null
  "$out/bin/reverie-resource-history" --help > /dev/null
  chmod -R a-w "$out"
''
