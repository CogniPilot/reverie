# Fixed factory inputs only. No caller-selected image, toolkit or native authority.
{ pkgs, src, image, toolkit, factory }:
let profile = pkgs.writeText "reverie-worker-factory-profile.json" (builtins.toJSON factory);
in pkgs.runCommand "reverie-worker-image-provenance" {
  nativeBuildInputs = [ pkgs.python3 ];
  meta.platforms = pkgs.lib.platforms.linux;
} ''
  python3 -I -B ${src}/python/reverie/worker_image_provenance.py --nix-build-inputs \
    --archive ${image} --source ${src} --profile ${profile} \
    --toolkit-manifest ${toolkit}/share/reverie-human-terminal/manifest.json \
    --output "$out/share/reverie/worker-image.json"
''
