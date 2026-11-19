# Generic browser/dispatch tools only. Matching NVIDIA libraries and devices are
# injected by an owner-reviewed host CDI spec, never a second driver in the image.
{ pkgs, src }:
let
  inherit (pkgs) lib;
  # The pinned GStreamer runtime installs a documentation generator whose
  # shebang keeps the interpreter in Chromium's closure. The browser still
  # uses the upstream executable, libraries and sandbox.
  upstream = {
    inherit (pkgs) chromium gtk4 libcamera libcanberra libnice openal-soft pipewire;
    inherit (pkgs.gst_all_1) gst-plugins-base gst-plugins-bad;
    gstreamer = pkgs.gst_all_1.gstreamer.out;
  };
  # Direct runtime references in the pinned closure. Keeping these as
  # derivation inputs lets flake evaluation run without building the browser.
  dependencies = {
    gstreamer = [ ];
    gst-plugins-base = [ "gstreamer" ];
    libcamera = [ "gstreamer" "gst-plugins-base" ];
    libcanberra = [ "gstreamer" ];
    libnice = [ "gstreamer" ];
    pipewire = [ "gstreamer" "gst-plugins-base" "libcamera" "libcanberra" ];
    openal-soft = [ "pipewire" ];
    gst-plugins-bad = [ "gstreamer" "gst-plugins-base" "libnice" "openal-soft" ];
    gtk4 = [ "gstreamer" "gst-plugins-base" "gst-plugins-bad" ];
    chromium = [ "gtk4" "pipewire" ];
  };
  runtime = lib.mapAttrs (name: inputs:
    let
      original = lib.getLib upstream.${name};
      rewrite = dependency: lib.escapeShellArgs [ (lib.getLib upstream.${dependency}) runtime.${dependency} ];
      storeName = builtins.substring 33 (-1) (builtins.baseNameOf (toString original));
    in pkgs.runCommandLocal storeName { nativeBuildInputs = [ pkgs.nix ]; } ''
      storeHash() { basename "$1" | cut -c1-32; }
      addRewrite() { printf 's|%s|%s|g\n' "$(storeHash "$1")" "$(storeHash "$2")" >> rewrites; }
      addRewrite ${original} "$out"
      ${lib.concatMapStringsSep "\n" (dependency: "addRewrite ${rewrite dependency}") inputs}
      # Some embedded self-references have a noncanonical name suffix. Nix
      # tracks their store hashes, so rewrite the fixed-width hash only.
      nix-store --dump ${original} | sed -f rewrites | nix-store --restore "$out"
      ${lib.optionalString (name == "gstreamer") ''
        helper="$out/libexec/gstreamer-1.0/gst-plugins-doc-cache-generator"
        chmod u+w "$(dirname "$helper")"
        rm -f "$helper"
      ''}
    '') dependencies;
  probeSource = pkgs.writeText "reverie-browser-gpu-probe.mjs"
    (builtins.readFile (src + "/scripts/browser-gpu-probe.mjs"));
  probe = pkgs.writeShellApplication {
    name = "reverie-browser-gpu-probe";
    runtimeInputs = [ pkgs.nodejs_22 ];
    text = ''exec node ${probeSource} "$@"'';
  };
in (pkgs.buildEnv {
  name = "reverie-browser-runtime";
  paths = [ runtime.chromium pkgs.vulkan-tools pkgs.libglvnd pkgs.vulkan-loader probe ];
  pathsToLink = [ "/bin" "/share" "/lib" ];
}).overrideAttrs (_: { disallowedRequisites = [ pkgs.python3 ]; })
