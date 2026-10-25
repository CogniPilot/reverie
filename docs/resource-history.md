# Resource history and producer observations

`cleanupObservations` packages the reviewed resource collector and path-free
receipt adapter. They do not grant cleanup, authenticate an effect, or install
services merely by building them:

```sh
nix build .#cleanupObservations
```

For NixOS, import `reverie.nixosModules.reverieCollect` and explicitly enable the
selected service. All paths and drive labels are nonsecret owner configuration:

```nix
services.reverie.collect = {
  enable = true;
  timer.enable = false;
  drives = { system = "/"; disposable = "/DISPOSABLE-MOUNT"; };
  pruneLogDirectory = "/var/lib/reverie-prune-declared/logs";
  receipts.enable = true;
};
```

The service and timer default off. An observation writes only private output
under `stateDirectory` (default `/var/lib/reverie-collect`). Existing foreign
directories, writable ancestors, links, or invalid custody markers are refused;
the initializer never chowns existing data. Systemd limits the service to
90 seconds, 256 MiB, 32 tasks and half a CPU. It retains host process visibility
and confines writes to its output directory. No engine command is needed.

Samples run every 300 seconds when the owner enables the timer. Daily samples
are retained for 30 days, rollups for 400; these settings are configurable.
GPU sampling is off unless the owner selects a compatible `gpuPackage` containing
`nvidia-smi`. Missing readings remain unavailable rather than fabricated zeros.

Optional producer receipts run after collection, serialized within the same
oneshot. They contain no paths or free text and remain explicitly unauthenticated
observations. This integration supplies no admission context and cannot promote
a reported deletion into an authenticated terminal result. A malformed input or
receipt failure makes the service fail rather than reporting success.

Private raw history is not automatically mounted into laptops or published on
the status page. A separate authorized read adapter must serve the selected
fields; declaring this module alone does not complete that UI integration.
The portable release installer must install the equivalent fixed unit and
configuration on non-Nix hosts; the NixOS wrapper is an optional backend.
