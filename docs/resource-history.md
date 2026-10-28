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

Version 2 samples retain the same aggregate `gpu_pct` arithmetic mean. Each GPU
reading now adds `uuid` and `identity_status`: a validated NVIDIA physical GPU
UUID (`GPU-` plus hexadecimal UUID, normalized to lowercase hexadecimal) has
status `available`. A missing/unsupported identity or sysfs fallback has
`uuid: null` and status `unavailable`; malformed or duplicate identities become
null with status `invalid` or `duplicate` for every affected member. A listing
above the existing 64-device metrics cap marks all returned identities
`incomplete`. Valid utilization remains visible in these cases. The transient
`index` is never a stable identity. Old samples may lack both new fields.

This metadata does not attribute GPU usage to employees or prove a resource
limit. New hour/day rollups add bounded `gpu_devices` statistics by validated
UUID without changing the aggregate arithmetic. Missing/duplicate identities
remain unavailable. Existing rollups have no per-device data and are never
backfilled from an index or a current GPU. No AMD/PCI identity scheme is added.

Optional producer receipts run after collection, serialized within the same
oneshot. They contain no paths or free text and remain explicitly unauthenticated
observations. This integration supplies no admission context and cannot promote
a reported deletion into an authenticated terminal result. A malformed input or
receipt failure makes the service fail rather than reporting success.

## Portable opt-in user service

The optional flake app works through an ordinary systemd user manager. It does
not modify NixOS, enable lingering, install a root service, start a daemon at
build time or change cleanup/resource permissions:

```sh
nix run .#collect -- init
# Inspect the new private ~/reverie/resource-history/config.json first.
nix run .#collect -- install
nix run .#collect -- start       # one bounded sample, explicitly requested
nix run .#collect -- enable      # explicitly enable the timer
nix run .#collect -- status
nix run .#collect -- stop        # stop both timer and current sample
nix run .#collect -- disable    # disable the timer persistently
```

`--config /ABSOLUTE/PRIVATE/CONFIG.json` selects a different owner-home file.
`init` never adopts a populated state directory. User mode has its own marker
(`.reverie-user-observations.json`), UID checks and private configuration. The
existing root initializer and root marker remain unchanged and cannot be used
as user-mode custody evidence. Existing differing units are refused rather than
overwritten. A separate private installation record binds the exact generated
unit bytes and fixed fragments. Every mutating unit control checks that record,
current bytes and actual loaded fragments/no drop-ins; names alone never allow
starting or stopping another application. Stop/disable do not require healthy
config/history, but still require intact own units. Read-only status reports
ownership separately from manager health. Install only publishes fixed units
and reloads the user manager;
it does not enable or start them. Repeating init/install preserves history.

The user service has a 90-second sample bound, 256 MiB/no swap, 32 tasks and half
a CPU. It calls the same collector, rollup and retention implementation; prune
inputs and producer receipts are disabled in user mode. GPU sampling defaults
off. An owner may select a matching immutable NVIDIA `nvidia-smi` explicitly in
`gpuExecutable`; no arbitrary tool command is accepted. Drive paths and optional
tool selection remain private configuration. This mode observes only what that
UID can read and never elevates or asserts complete host attribution.

Enabled user timers survive user-manager restarts, with persistent sample files
and cursors. There is no fabricated backfill while the manager is absent; a
logged-out manager without owner-configured lingering may not run. Unsupported
user cgroup/sandbox/resource controls must fail visibly; installation alone is
not evidence of an active or correctly constrained collector. Native activation
still requires checking actual unit limits, write confinement, protected state
outside worker mounts, selected tool/driver compatibility, restart survival and
freshness. This source task does not perform those checks or installation.

## Bounded history reads

The same package supplies `reverie-resource-history`:

```sh
RESULT/bin/reverie-resource-history --config /ABSOLUTE/PRIVATE/CONFIG.json \
  --start UNIX_SECONDS --end UNIX_SECONDS --resolution hour
```

The reader accepts at most 400 days and 1024 output buckets (`auto`, `minute`,
`five-minute`, `hour`, `day`). Optional `--gpu GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
selects one recorded UUID. Aggregate and per-device values are separate; gaps
are null, never zero-filled/interpolated. Downsampling uses recorded sample
counts, with min/weighted average/max. The response includes latest sample time,
configured interval/retention, stale/missing status, malformed-line counts and
explicit older-device coverage limitations. Reads never repair/delete history.
They refuse links, foreign/hard-linked/writable files, changing custody, excessive
files/bytes/rows and oversized output. A five-second cooperative read budget is
also enforced; kernel I/O itself is not a hard real-time promise.

Filename UTC intervals select only relevant resolution files. Committed rollup
periods wholly inside the query take precedence; raw records supply uncovered
or partial query buckets, including per-device data missing from old rollups.
Raw and rollup counts for one bucket are never added together. A closed rollup
interval does not assert complete sampling: its recorded counts and gaps remain.
`deviceUUIDs` is scoped to the records used for this query, not an all-history
device registry. Malformed-line counts cover only read records, not an archive
audit. Freshness separately uses at most eight newest raw date files, reading
only their final 256 KiB unless already read. `freshnessReadComplete: false`
marks a partial tail; `lastSampleAt` then means latest valid observed tail time,
not a proof that the whole archive was scanned. Missing valid evidence in that
bounded search is `unavailable`. Full history-file reads keep their 8 MiB bound;
all read bytes/rows still share the original 32 MiB/100,000-row request limits.

The web adapter provides owner-only `GET /api/resource-history` with fixed
`start`, `end`, `resolution` and optional `gpu` parameters. It requires a genuine
current full owner session even if the general owner policy is off; limited,
agent, service and anonymous identities do not gain access. It rechecks owner
authority after I/O. No request may select a path, executable, configuration,
host, command or service action. Server startup must explicitly select
`REVERIE_RESOURCE_HISTORY_CLI` (the immutable package's fixed history CLI) and
`REVERIE_RESOURCE_HISTORY_CONFIG` (its private user configuration). Without
those values it reports 503. One read runs at a time, with an eight-second child
timeout and 2 MiB output bound; diagnostics/paths are not returned. These
observations carry no cleanup, allocation, employee attribution or limit proof.

Private raw history is not automatically mounted into laptops, exposed to the
status page or published by this change. A container website needs separately
reviewed read-only package/config/state access with consistent absolute paths
and UID/home custody; no new mount or service is installed by the API. Root-mode
history requires a separate explicit read contract rather than weakening its
existing custody. API installation/readiness and graph/UI acceptance remain
native follow-up gates, coordinated with the existing resource-history UI.
