# Optional rootless Docker in laptops

The normal laptop image stays lean. Projects provide their own environments with
`nix develop`, `nix build` and `nix run`. Use `nix shell nixpkgs#openssh` for a
temporary tool, or `nix profile install nixpkgs#openssh` to keep it in the employee's
private home and Nix store.

Docker build/run is a separate owner-selected capability. It needs the matching
`lib.workerDockerImage` factory image for the broker's nonroot UID/GID and an
existing host subordinate UID/GID allocation. The factory takes `system`, `uid`,
`gid`, `subuidStart`, `subgidStart` and `subidCount` (at least 65536). The broker
checks the image labels and actual protected host `/etc/subuid` and `/etc/subgid`
grants before creating a laptop. Missing grants or mismatched images refuse;
this feature does not modify host accounts or host operating-system configuration.

Use a reviewed Git revision as the factory's flake input:
`builtins.getFlake ("git+file://" + toString ./. + "?rev=" + revision)`.
This keeps local Git metadata, caches and untracked files out of the image.

The optional broker `rootlessDocker` object contains exactly `enabled`,
`seccompProfile` and `seccompSha256`. The profile is the immutable
`workerDockerSeccomp` output with its actual SHA-256. Default/off retains the
normal laptop security policy. Owner configuration must remove obsolete
passwd/group bind mounts: identity, subordinate-ID metadata and mapping helpers
come from the immutable image and cannot be replaced by grants, even read-only
ones. Normal project mounts remain explicit.

Enabled laptops accept static drives at `/workspace`, `/reverie_workspace`,
`/projects` or `/projects/NAME`. The fixed publication, tool, statusline and model
slots must be read-only. Other destinations and overlapping bind targets refuse,
including nested selected-account binds. The matching factory verifies empty,
plain mount namespaces before producing its layout label. This prevents a
symlink inside a writable drive, or an image alias into writable Nix, from
redirecting a later bind over privileged helper code or identity metadata.

With the capability enabled, install the optional tools from a Reverie checkout:

```bash
nix profile install .#workerDocker
dockerd-rootless
```

Use `nix shell .#workerDocker` for a temporary environment instead. The packaged
launcher selects VFS, RootlessKit/Slirp and a runtime that disables per-container
session keyrings. Leave that launcher running while using `docker build` and
`docker run` from another laptop terminal. The broker sets a private
`XDG_RUNTIME_DIR` and `DOCKER_HOST`; no host or peer engine socket is mounted.
Daemon state defaults to the durable employee home (`~/.local/share/docker`).
Build/download caches and temporary outputs belong in the private scratch-backed
`/tmp`. Required volumes and retained results must stay on durable storage.

The outer laptop remains nonroot with a read-only image, its existing memory,
swap and process ceilings, and any configured CPU quota. It permits only SETUID/SETGID in the
capability bounding set, used by two file-capability mapping helpers. Their
interpreter, libraries and plugin paths never load from the laptop's writable
Nix store. The syscall profile retains default denials, including host keyrings,
BPF and performance tracing. Rootless namespace setup requires unmasked system
paths; ordinary laptop processes still cannot write host `/proc/sys` or `/sys`
controls. No SYS_ADMIN, privileged container or host engine socket is granted.
Inner Docker may report unavailable cgroup controllers: outer laptop limits are
the enforced ceiling; inner `--memory` limits are not an additional guarantee.
