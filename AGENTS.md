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

Use $HOME/scratch on the host and /scratch in the container for builds, compiler
caches, downloads, profiling traces and temporary task artifacts. Reuse owned caches;
never move a cache in use or delete another task's work. Use the leased task-workspace
helper for cleanup, save a handoff first, and preserve unfinished/source work.

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
