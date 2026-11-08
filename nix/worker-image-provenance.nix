# Fixed factory inputs only. No caller-selected image, toolkit or native authority.
{ pkgs, src, image, toolkit, factory, workerChild }:
let
  profile = pkgs.writeText "reverie-worker-factory-profile.json" (builtins.toJSON factory);
  artifacts = import ./policy-artifacts.nix { inherit pkgs src; };
in pkgs.runCommand "reverie-worker-image-provenance" {
  nativeBuildInputs = [ pkgs.python3 ];
  meta.platforms = pkgs.lib.platforms.linux;
} ''
  python3 -I -B ${src}/python/reverie/worker_image_provenance.py --nix-build-inputs \
    --archive ${image} --source ${src} --profile ${profile} \
    --toolkit-manifest ${toolkit}/share/reverie-human-terminal/manifest.json \
    --output "$out/share/reverie/worker-image.json"
  chmod 444 "$out/share/reverie/worker-image.json"
  ${artifacts}/bin/reverie-policy-artifacts worker-child-image \
    --manifest ${workerChild}/share/reverie/worker-child-program.json \
    --base-provenance "$out/share/reverie/worker-image.json" \
    --output "$out/share/reverie/worker-child-image.json"
''
