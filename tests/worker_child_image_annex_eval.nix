# Inert JSON/context fixtures only. No native producer or image is executed.
let
  raw = value: builtins.unsafeDiscardStringContext (toString value);
  archive = builtins.toFile "annex-eval-archive" "inert fixture";
  source = builtins.toFile "annex-eval-source" "inert fixture";
  toolkitRoot = builtins.toFile "annex-eval-toolkit" "{}";
  toolkit = raw toolkitRoot + "/share/reverie-human-terminal/manifest.json";
  programRoot = builtins.toFile "annex-eval-program" "inert fixture";
  program = raw programRoot + "/bin/reverie-worker-child";
  manifest = builtins.toFile "annex-eval-manifest.json"
    (builtins.toJSON { program.path = raw program; });
  base = builtins.toFile "annex-eval-base.json" (builtins.toJSON {
    version = 1;
    purpose = "worker-image-provenance-v1";
    archiveConfigSHA256 = builtins.concatStringsSep "" (builtins.genList (_: "a") 64);
    archive.path = raw archive;
    source.path = raw source;
    toolkit.manifest.path = raw toolkit;
    imageSpec.Config.Labels."org.reverie.worker.child-manifest" = raw manifest;
    factory = { };
  });
  pkgs = {
    runCommand = _: attributes: _: attributes.passthru;
  };
  invoke = baseProvenance: import ../nix/worker-child-image-annex.nix {
    inherit pkgs baseProvenance; src = ../.;
  };
  literal = import (builtins.toFile "annex-eval-literal.nix" (toString base));
  selected = (invoke literal).declaredInputReferences;
  expected = map raw [ base archive source toolkit manifest program ];
  roots = [ base archive source toolkitRoot manifest programRoot ];
  retained = index: builtins.hasAttr (raw (builtins.elemAt roots index))
    (builtins.getContext (builtins.elemAt selected index));
  refused = builtins.tryEval (builtins.deepSeq (invoke "/tmp/foreign-base.json").declaredInputReferences true);
in assert builtins.isPath literal;
assert map toString selected == expected;
assert builtins.all retained (builtins.genList (index: index) 6);
assert !refused.success;
true
