# Test-only namespaced images. The default production factories are unchanged.
{ pkgs, src, namePrefix }:
assert builtins.match "reverie-ci-memory-high-[0-9a-f]{32}" namePrefix != null;
let
  helper = import ./docker-resource-helper.nix { inherit pkgs src; };
  baseline = import ./docker-resource-helper-image.nix {
    inherit pkgs helper;
    name = "${namePrefix}-baseline";
  };
  writer = import ./docker-resource-helper-image.nix {
    inherit pkgs helper;
    name = "${namePrefix}-writer";
    memoryHighOnly = true;
  };
  console = (import ./package.nix { inherit pkgs src; }).console;
  originalWriter = import ./docker-original-writer-canary.nix { inherit pkgs console; };
  manifest = pkgs.writeText "memory-high-native-inputs.json" (builtins.toJSON {
    version = 1;
    purpose = "reverie-ci-memory-high-images-v1";
    inherit namePrefix;
    baselineTag = "${namePrefix}-baseline:latest";
    writerTag = "${namePrefix}-writer:latest";
    imageIdentity = "actual-engine-inspection-required";
  });
in pkgs.linkFarm "reverie-ci-memory-high-images" [
  { name = "baseline.tar.gz"; path = baseline; }
  { name = "writer.tar.gz"; path = writer; }
  { name = "manifest.json"; path = manifest; }
  { name = "original-writer.mjs"; path = originalWriter + "/original-writer.mjs"; }
  { name = "original-writer.meta.json"; path = originalWriter + "/original-writer.meta.json"; }
]
