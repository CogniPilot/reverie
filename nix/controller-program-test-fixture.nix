# Immutable bytes for producer integration tests; this program is never executed.
{ pkgs }:
pkgs.runCommand "reverie-controller-program-test-fixture" {} ''
  install -Dm555 ${pkgs.coreutils}/bin/true "$out/bin/reverie-worker-resource-controller"
  install -Dm555 ${pkgs.coreutils}/bin/false "$out/foreign/bin/reverie-worker-resource-controller"
''
