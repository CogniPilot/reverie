# Office laptops

An expert's tools run in a separate container with a private home and terminal. The laptop's durable data belongs to its permanent employee ID and survives model, plan and session changes. Human names label folders; they grant no permissions. The remote model supplies reasoning; its local CLI runs tools.

The website provides office chat and management. A website restart can leave laptop programs running. Restarting a laptop ends its processes; durable files and conversation records do not themselves preserve a running CLI.

## Install tools with Nix

Use the project's pinned flake first:

```bash
nix develop
nix develop --command python3 -m unittest discover -s tests
nix build
nix run
```

For temporary tools or persistent profile installs:

```bash
nix shell nixpkgs#openssh --command ssh -V
nix profile install nixpkgs#jq
nix profile list
```

The laptop's `nixpkgs` registry follows the release lock. Its writable `/nix/store`, database and private home live outside scratch at `stateRoot/employees/<employeeId>/{nix,home}`. Installed profiles and registered packages survive container replacement. Temporary shell packages can be collected unless a profile or another garbage-collection root retains them.

Keep the base laptop lean. Use project flakes for simulators and large build stacks. QEMU software emulation needs no KVM device; accelerated KVM requires an explicit grant. Docker needs an owner-enabled engine, not just a client. When rootless Docker is enabled, install `.#workerDocker` from a Reverie checkout, run `dockerd-rootless` in another terminal, and verify `docker info` before building or running containers. Its images and volumes remain in `~/.local/share/docker`.

Read `/home/agent/AGENTS.md` for current laptop instructions. Installing tools grants no mission or flight approval. Credentials need named grants outside scratch; never paste secret bytes into chat.

## Files and temporary work

Use these Linux paths:

- `/home/agent`: private settings, SSH configuration and retained work.
- `/nix`: installed tools, profiles and the package database.
- `/workspace` or explicit project mounts: durable shared work when granted. `/reverie_workspace` remains compatible.
- `/tmp/<task>`: task-specific temporary builds, disposable source checkouts, dependency caches and regenerable downloads. `TMPDIR`, `TMP` and `TEMP` point to `/tmp`.

`/tmp` uses this laptop's private directory on the scratch disk, rather than a small RAM filesystem. `/scratch` is also disposable and remains for compatibility. Temporary storage may be wiped periodically: recreate it and verify source revisions, input hashes and required tools at each run. Check shared disk capacity before heavy work. Use normal project commands and the provided environment defaults.

Keep unique data, unpushed or uncommitted work, cited evidence, results, latches, configuration, credentials and installed tools in verified durable storage. Verify backing storage; project mounts and owner files take precedence over aliases.

Save and verify a handoff before cleanup; after sealing remove only task-owned registered disposable outputs. Registration, names and gitignore do not prove disposability. Respect live leases, protect sockets and runtime state, never move active caches or sockets, and preserve other tasks' work and shared stores.

Legacy laptops require coordinated offline migration of home and Nix together. Save a handoff and keep their existing stores and profile links intact. Do not restart the broker to install a package; ordinary Nix commands need neither the host daemon nor another laptop's store.

## Protection and access

CPU is uncapped by default. Owner-selected memory, no-swap and task ceilings plus admission checks protect the host; threads count as tasks. The portable local Linux backend requires no personal NixOS configuration. Optional shared-pool protection must already be verified; missing protection never permits unlimited fallback.

Laptops receive explicit project mounts, selected accounts and a scoped office API. They receive no host engine/control socket or console private state. There is no peer SSH network by default. Use `REVERIE_API_URL`; a title or folder name grants no authority. Browser/GPU access requires explicit grants and a validated runtime.

See [Work and scratch](/handbook/work), [Power and restarts](/handbook/power) and [Recovery](/handbook/recovery).
