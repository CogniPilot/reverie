# Work, shared drives and scratch

Keep source, unfinished work and durable review evidence in the appropriate repository. Each expert should use its own checkout or worktree and branches for review. Shared project mounts are shared drives; they do not grant control of a colleague's laptop.

Use the project's native flake development environment. The fact that a tool exists on the host does not mean it exists inside a laptop. A host-only node_modules symlink is not a portable development environment.

## Scratch ownership

Use /scratch inside a laptop for disposable builds, downloads, compiler caches and task artifacts. Scratch belongs to that laptop's labelled owner. On the host, derive local paths from HOME and use the configured scratch drive; never hard-code a personal username into project sources.

The deployment defaults to a scratch location under the Reverie folder. Owners may point it at another drive through their deployment configuration or mount. Do not replace or move a cache while a process uses it.

Use the leased task-workspace helper. Save a handoff before cleanup, preserve unfinished source and do not delete another task's data. Automatic pruning must respect ownership and active leases.

Review code through the repository's normal branch/PR workflow. Follow the project's checks and deployment coordination; a title does not authorize live changes.

See [Office laptops](/handbook/laptops).
