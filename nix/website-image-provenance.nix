# Immutable image/program facts only: no service, private state or authority.
{ pkgs, src, image, console, clientManifest, startupManifest ? null }:
pkgs.runCommand "reverie-website-image-provenance" {
  nativeBuildInputs = [ pkgs.python3 ];
  meta.platforms = pkgs.lib.platforms.linux;
} ''
  python3 -I -B ${src}/python/reverie/website_image_provenance.py --nix-build-inputs \
    --archive ${image} --console ${console} \
    --node ${pkgs.nodejs_22}/bin/node \
    --client-manifest ${clientManifest}/share/reverie/resource-client.json \
    ${pkgs.lib.optionalString (startupManifest != null) "--program-manifest ${startupManifest}/share/reverie-owner-terminal/website-program.json"} \
    --output "$out/share/reverie/website-image.json"
''
