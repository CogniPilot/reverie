# Reverie contributor instructions

Read README.md. Use the self-contained native flake environment with
`nix develop` for development. The optional isolated development container is
available through `./scripts/reverie-container exec COMMAND ...`; Podman is not
required for the native runtime. Bootstrap/engine control and private migration
brokers run on the host. Never mount personal instance data into a development
or shared container.

All experts are generic AI agents with their own memories. CTO, COO and specialist
titles are organizational roles. Tool permissions and chat/coding mode are separate;
a title grants no authority.
Identity, relationships, model selection, credentials and memory are owner-selected
instance data. Keep them outside this shareable repository.
Use `python/reverie/` for the shared runtime and `python/experts/` for specialist templates.

Put temporary builds, disposable source checkouts, dependency caches and
regenerable downloads in a task-specific directory under `/tmp`. Check shared
disk capacity before heavy work. Temporary storage may be wiped periodically;
recreate it and verify source revisions, input hashes and required tools at each
run. Use normal project commands and the provided environment defaults.

Keep unique data, unpushed or uncommitted work, cited evidence, results and
one-attempt latches in verified durable workspace, project or private home storage.
Keep configuration, credentials and installed tools outside disposable roots.
Preserve and verify durable source, evidence and results before cleanup, then
remove the task's registered disposable outputs after sealing results. Registration,
a path name or a Git ignore rule alone does not prove a file is disposable.

Reuse owned caches; never move a cache in use. Use the leased task-workspace
helper for cleanup, save a handoff first.

Cleanup must respect live task leases and protect active sockets, runtime state
and credentials. Do not move or delete a live socket by hand. Do not clean another
task's files, shared caches or Nix store paths without specific preservation and
ownership checks.

Run `python3 -m unittest discover -s tests` and
`node --test tests/test_opencode_plugin.mjs` in the flake environment (or the
optional development container). Use explicit file
paths when staging; do not stage instance data, runtime metadata or local receipts.

The host boundary is controlled outside the container. Container sudo does not grant
host sudo. Optional NixOS account changes need ordinary owner activation; never use
a container engine as a workaround for missing host administrator authentication.

An owner-appointed coordinator with explicit orchestration permission prepares task
context. Delegate only when the user has authorized delegation. Read the
reverie-context skill, select
relevant verified project evidence and lookup hints, and budget for the actual model.
Keep required acceptance checks intact; improve briefs from worker feedback.
