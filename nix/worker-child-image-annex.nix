# Annotation-only release artifact. The base keeps its original image/source;
# this producer adds no image, runtime, admission or qualification authority.
{ pkgs, src, baseProvenance }:
let
  # JSON strings lose Nix reference contexts. Restore the ORIGINAL store root
  # without copying a path input or changing any selected subpath spelling.
  reference = input:
    let
      value = toString input;
      parts = builtins.match "(/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/]+)(/.*)?" value;
    in assert parts != null;
      builtins.appendContext value {
        "${builtins.elemAt parts 0}" = { path = true; };
      };
  base = reference baseProvenance;
  document = builtins.fromJSON (builtins.readFile base);
  manifest = reference document.imageSpec.Config.Labels."org.reverie.worker.child-manifest";
  child = builtins.fromJSON (builtins.readFile manifest);
  declaredInputReferences = [
    base
    (reference document.archive.path)
    (reference document.source.path)
    (reference document.toolkit.manifest.path)
    manifest
    (reference child.program.path)
  ];
  inputs = pkgs.writeText "reverie-worker-child-annex-inputs"
    (builtins.concatStringsSep "\n" declaredInputReferences + "\n");
  producer = import ./policy-artifacts.nix { inherit pkgs src; };
in pkgs.runCommand "reverie-worker-child-image-annex" {
  nativeBuildInputs = [ producer ];
  passthru = { inherit declaredInputReferences; };
} ''
  mkdir -p "$out/share/reverie"
  reverie-policy-artifacts worker-child-image-annex \
    --base-provenance ${pkgs.lib.escapeShellArg base} --output "$out/share/reverie/worker-child-image.json"
  # Keep all actual original closure references even when the supplied immutable
  # JSON file was sealed separately and has no references in the Nix database.
  cp ${pkgs.lib.escapeShellArg inputs} "$out/share/reverie/worker-child-annex-inputs"
  chmod 444 "$out/share/reverie/worker-child-image.json"
''
