# Office laptops

An expert's tools run on its persistent employee laptop: a separate container with a private home, terminal and disposable temporary drive. The laptop belongs to the stable employee identity and survives model, account and conversation/session changes. A human-friendly folder name is an alias, not an identity or permission. The remote model supplies reasoning; the CLI inside the laptop connects that model to its tools.

The website is the office communication and management service. Restarting the website can leave laptop programs running. Restarting the laptop itself ends processes inside it; preserving the same CLI across that restart needs a separately supervised backend and is not guaranteed by the website/laptop split.

## Installing tools with Nix

Use a project's pinned environment when it has a flake:

```bash
nix develop
nix develop --command python3 -m unittest discover -s tests
```

Use a temporary tool environment for a single command, or install a tool in your private profile for later shells:

```bash
nix shell nixpkgs#jq --command jq --version
nix profile install nixpkgs#jq
nix profile list
jq --version
```

The laptop's `nixpkgs` registry follows the release lock. Profiles live in your private home, including `~/.nix-profile` and `~/.local/state/nix/profiles`. Each laptop has its own writable `/nix/store` and `/nix/var/nix` database. New and migrated laptops bind these from the private durable `stateRoot/<sessionId>/nix` directory on the host. Installed profiles and their registered packages survive laptop recreation; a running process still ends when its laptop stops. Temporary shell packages can be collected when no profile or other garbage-collection root retains them.

Older laptops may still bind `/nix` from their private scratch drive until an owner coordinates migration. Keep the existing store and profile links intact, save a handoff, and report the exact laptop/session before maintenance. A broker restart can also interrupt terminal and provider transports; do not restart it to install a package. The host daemon and another laptop's store are never needed for ordinary laptop Nix commands.

`/tmp` mounts only this laptop's private directory on the owner's scratch disk; it is not a small RAM tmpfs or the whole shared scratch root. `TMPDIR`, `TMP` and `TEMP` point to `/tmp`. Put disposable builds, caches and downloads under `/tmp/<project>/...`; default tool paths separate working directories. `/scratch` remains a compatibility drive for existing paths and is disposable too. Keep repositories, unfinished work, scientific results and retained evidence in verified durable project/workspace or private home storage. Existing work must be preserved before scratch cleanup; neither a directory name nor stopping jobs proves its contents are disposable.

The portable Linux/local-engine default uses individual memory/no-swap and task ceilings plus aggregate admission; CPU is uncapped. It needs no personal NixOS configuration. The shared-pool backend is optional and requires separately available, verified protection. An absent pool never permits unlimited fallback. A broker user service can start at login (or through an owner's existing linger policy); laptop containers deliberately do not blindly restart provider commands. Follow coordinated normal same-conversation recovery after reboot.

## Protection

CPU is uncapped by default and shared fairly. Memory and task ceilings prevent a runaway laptop from exhausting the whole host. Threads count toward the task limit. Limits and admission budgets are owner-selected host policy; check actual deployment settings before quoting numbers.

Each laptop has an init process to reap orphaned children. An unavailable broker must fail closed rather than execute tools inside the website container.

## Boundaries

Laptops get explicitly shared project mounts, selected accounts and a scoped office API. They do not get the engine socket, host-control socket or console private state. Internet access does not imply access to colleagues' laptops. There is no peer SSH network by default.

Use the scoped API base in REVERIE_API_URL. Do not copy owner service tokens or passwords into a laptop to bypass missing permissions.

Optional browser/GPU access needs explicit host grants and a validated image. Native graphics success alone does not prove container graphics, WebGPU or safe coexistence with model inference.

See [Work and scratch](/handbook/work) and [Power and restarts](/handbook/power).
