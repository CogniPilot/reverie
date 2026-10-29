# Optional resource actor installation

The normal owner API remains the authority for each resource operation. These
installation steps bind trusted code and native facts; they grant no approval,
create no resource allocation and start no website, broker or employee.

Use the same reviewed source for the website image and host broker. The optional
installer builds an immutable image/program manifest from that flake graph:

```sh
nix build .#resourceActorImageProvenance
nix run .#resource-actor-install -- \
  --config /ABSOLUTE/PRIVATE/worker.json \
  --resource-actor-engine-socket /run/docker.sock
```

Select the actual local Unix socket for a rootless/custom engine. Keep instance
configuration outside the repository. `resourceReservations` must select the
existing private admission/journal directory, and `resourceActorConfig` must be
its `resource-actor.json`. The ordinary installer remains unchanged when this
optional feature is absent.

Explicit installation retains the provenance package and its referenced console,
client and interpreter closure through a private Nix GC root. Rebinding retains
earlier generation roots for inspection; it does not silently garbage-collect
data or code needed to understand a previous operation.

First coordinate an inactive broker transport through its supported maintenance
workflow. The installer refuses active units and any remaining broker socket;
it never deletes a socket or stops a process for you. Existing provider/laptop
maintenance and any website cutover require their own qualified workflow.

The selected running website must use a protected read-only root, dropped
capabilities, no-new-privileges, a private PID namespace and no Nix code masks or
loader-injection settings. The existing default website is not presumed to meet
this optional profile. The package must actually contain the declared Node,
console and isolated Python client bytes on its read-only filesystem. Unsupported
kernel/engine/protection features refuse rather than adding host OS setup.

During explicit installation the helper verifies full image configuration and
RootFS identities, derives the configured website's full native specification,
finds the unique fixed Node entry in that init's namespaces, and checks its peer
and code facts. It publishes a private version-2 bootstrap under the existing
admission lock only with no active or inconsistent pending operation. Rebinding
preserves the previous file by content hash and compares current bytes before
replacement. A retained `resource-actor.installing.json`, changed current file,
unknown journal or failed postcheck refuses: preserve those files for inspection;
do not erase pending state or interpret the error as a successful installation.
The installation fence remains present through every post-publication check.
Runtime loading and already loaded guards also refuse while that fence exists.
A retained `resource-actor.next.json` is staged evidence, not an active record.

The runtime only opens existing facts. Every use rechecks private custody, the
broker domain, immutable manifest, actual image, website incarnation, complete
Config/HostConfig/Mounts and namespace-aware executable/argv identities. The raw
archive configuration hash and the engine's distribution-manifest image ID are
different namespaces and are checked separately. The protected peer preserves
these checks when substituting the fixed Python client for a launch.

`worker-service install` publishes/enables its fixed unit without starting it.
Before a supported start and first canary, complete the actual installed
readiness, owner-purpose protocol, journal/hold recovery and resource-operation
acceptance checks. Source tests and a built manifest are not a successful resize.

## Refresh after a website replacement

After the registered broker has been installed with connection-local facts,
explicitly rebind a new, separately qualified website incarnation without
restarting the broker or laptops:

```sh
nix run .#resource-actor-refresh -- \
  --config /ABSOLUTE/PRIVATE/worker.json \
  --resource-actor-engine-socket /run/docker.sock
```

Refresh accepts only the existing packaged service, exact private configuration,
no service drop-ins, and its actual running process/socket peer. It sends no
request frame and keeps that peer bound through publication.

The installed unit and its private Nix GC root select the broker generation.
A website rebuild can retain that generation when its complete immutable Python
source matches the refresh tool. Changes to that Python source require a
coordinated broker upgrade; a new website source path alone does not.

The same admission lock, immutable image/program checks, inactive-operation checks and pending
fence apply. It does not provision a missing admission domain or clear unknown
state. The old website proof stays fenced; later connections load fresh facts.
This operation grants no owner approval, resumes no operation and changes no
resource allocation. Installed lifecycle and peer continuity still require
their actual acceptance checks.

## Website runtime selection

The owner deployment file accepts `websiteRuntime`: `default` (ordinary website),
`resource` (resource replacement), `terminal` (protected laptop terminals), or
`resource-terminal` (both). Omission keeps the ordinary deployment unchanged.
Every optional runtime requires `protectedWebsite: true` and its separate native
installation. The start/update tools build only the corresponding fixed flake
image; they accept no command, image attribute or launcher from a chat request.

For the combined runtime, build `resourceTerminalImageProvenance` and use
`nix run .#resource-terminal-install` / `nix run .#resource-terminal-refresh`
with the same private config and engine-socket options shown above. These
launchers pin the matching startup manifest; standalone resource installation
does not require the human-terminal service. The human-terminal cold/restart
rendezvous must be qualified before enabling the combined profile. The updater
preserves existing protection and refuses changing a plain website into this
profile without its explicit coordinated activation workflow.
