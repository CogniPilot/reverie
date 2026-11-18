# Fixed factory inputs only. No caller-selected image, toolkit or native authority.
{ pkgs, src, image, toolkit, factory, workerChild, artifacts ? import ./policy-artifacts.nix { inherit pkgs src; } }:
let
  profile = pkgs.writeText "reverie-worker-factory-profile.json" (builtins.toJSON factory);
  inputs = builtins.fromJSON (builtins.readFile
    ../crates/reverie-contracts/src/resource_actor/provenance_build/worker-factory-v2.json);
  leaf = name: builtins.path {
    path = (src.origSrc or src) + "/${name}";
    name = builtins.baseNameOf name;
  };
  factorySource = pkgs.runCommand "reverie-worker-factory-source" {} (
    pkgs.lib.concatMapStringsSep "\n" (name: ''
      install -Dm444 ${leaf name} "$out/${name}"
    '') inputs
  );
in pkgs.runCommand "reverie-worker-image-provenance" {
  meta.platforms = pkgs.lib.platforms.linux;
} ''
  ${artifacts}/bin/reverie-policy-artifacts worker-image-provenance \
    --archive ${image} --source ${factorySource} --profile ${profile} \
    --toolkit-manifest ${toolkit}/share/reverie-human-terminal/manifest.json \
    --output "$out/share/reverie/worker-image.json"
  chmod 444 "$out/share/reverie/worker-image.json"
  ${artifacts}/bin/reverie-policy-artifacts worker-child-image \
    --manifest ${workerChild}/share/reverie/worker-child-program.json \
    --base-provenance "$out/share/reverie/worker-image.json" \
    --output "$out/share/reverie/worker-child-image.json"
''
