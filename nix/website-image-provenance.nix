# Immutable image/program facts only: no service, private state or authority.
{ pkgs, src, image, console, clientManifest, startupManifest ? null, nodeInvocation ? "package" }:
let
  # The native front execs the actual resolved Node ELF. The ordinary package
  # invocation and explicit startup-manifest recipe retain their existing argv.
  node = "${pkgs.nodejs_22}/bin/node";
  nodeArgument = if nodeInvocation == "native-front" then
    ''"$(${pkgs.coreutils}/bin/readlink -e -- ${pkgs.lib.escapeShellArg node})"''
    else pkgs.lib.escapeShellArg node;
in
assert pkgs.lib.assertMsg (builtins.elem nodeInvocation [ "package" "native-front" ])
  "Unknown website Node invocation purpose";
assert pkgs.lib.assertMsg (nodeInvocation != "native-front" || startupManifest == null)
  "Native-front provenance cannot replace an explicit startup manifest recipe";
pkgs.runCommand "reverie-website-image-provenance" {
  nativeBuildInputs = [ pkgs.python3 ];
  meta.platforms = pkgs.lib.platforms.linux;
} ''
  python3 -I -B ${src}/python/reverie/website_image_provenance.py --nix-build-inputs \
    --archive ${image} --console ${console} \
    --node ${nodeArgument} \
    --client-manifest ${clientManifest}/share/reverie/resource-client.json \
    ${pkgs.lib.optionalString (startupManifest != null) "--program-manifest ${startupManifest}/share/reverie-owner-terminal/website-program.json"} \
    --output "$out/share/reverie/website-image.json"
''
