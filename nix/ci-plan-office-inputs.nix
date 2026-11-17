# Hosted acceptance composes the same current-source factory, never private store paths.
{ pkgs, src, dependencyConsole, imageNamespace }:
let
  clientCapsule = import ./worker-client-capsule.nix {
    inherit pkgs src;
    console = dependencyConsole;
  };
  clientManifestDigest = builtins.hashFile "sha256" "${clientCapsule}/opt/reverie-worker-client/manifest.json";
  images = import ./ci-plan-office-images.nix {
    inherit pkgs src dependencyConsole imageNamespace clientCapsule clientManifestDigest;
  };
  metadata = pkgs.writeText "ci-plan-office-inputs.json" (builtins.toJSON {
    version = 1;
    purpose = "reverie-ci-plan-office-inputs-v1";
    inherit imageNamespace clientManifestDigest;
    sourcePath = toString src;
    runtimePath = toString images.runtime;
    platformClosure = toString images.platformClosure;
  });
in {
  stage = pkgs.linkFarm "reverie-ci-plan-office-inputs" [
    { name = "metadata.json"; path = metadata; }
    { name = "runtime"; path = images.runtime; }
    { name = "client"; path = clientCapsule; }
    { name = "platform-closure"; path = images.platformClosure; }
    { name = "source.tar.gz"; path = images.sourceImage; }
    { name = "worker.tar.gz"; path = images.workerImage; }
    { name = "helper.tar.gz"; path = images.helperImage; }
  ];
  inherit (images) mkControl;
}
