# Optional fixed H composition; private auth contents are never build inputs.
{ pkgs, src, packages, serviceAuthConfig ? null }:
let
  selected = import ./service-auth-config.nix { inherit (pkgs) lib; } serviceAuthConfig;
in rec {
  ownerTerminalCore = import ./owner-terminal-core.nix { inherit pkgs src; };
  humanTerminalToolkit = import ./human-terminal-toolkit.nix { inherit pkgs src; };
  ownerTerminalHost = import ./owner-terminal-host.nix {
    inherit pkgs src; inherit (packages) console memory memoryPackage entrypoint;
    serviceAuthConfig = selected;
  };
  ownerTerminalWebsiteManifest = ownerTerminalHost.websiteManifest;
  ownerTerminalImage = import ./image.nix {
    inherit pkgs src; inherit (packages) reverie console memory runtime;
    ownerTerminalWebsite = ownerTerminalHost.website;
  };
  ownerTerminalImageProvenance = import ./website-image-provenance.nix {
    inherit pkgs src; image = ownerTerminalImage; console = packages.console;
    clientManifest = packages.workerResourceClientManifest;
    startupManifest = ownerTerminalWebsiteManifest;
  };
  ownerTerminalLifecycle = import ./owner-terminal-lifecycle.nix {
    inherit pkgs src; memory = packages.memory; profile = "terminal";
    websiteManifest = ownerTerminalWebsiteManifest;
    imageProvenance = ownerTerminalImageProvenance; toolkit = humanTerminalToolkit;
  };
  # The declared H startup hash/command is paired with this native generation.
  nativeWorkerPackages = import ./native-worker-packages.nix {
    inherit pkgs src; console = packages.console;
    ownerTerminalProgram = if selected == null then null else
      "${ownerTerminalWebsiteManifest}/share/reverie-owner-terminal/website-program.json";
  };
  ownerTerminalWebsiteSetup = import ./owner-terminal-website.nix {
    inherit pkgs src; memory = packages.memory; lifecycle = ownerTerminalLifecycle;
    workerUnit = nativeWorkerPackages.workerService;
    workerBrokerSource = nativeWorkerPackages.workerBrokerSource;
  };
}
