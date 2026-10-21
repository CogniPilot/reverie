# Reverie contributor instructions

Read README.md. Work inside the fleet development container:
`./scripts/fleet-container exec COMMAND ...`. Bootstrap/engine control and private
migration brokers run on the host. Never mount personal instance data into the
development or shared container.

The container supports owner-selected agent roles, including CTO and generic local
agents. Organizational role, tool permissions and chat/coding mode are separate.
Identity, relationships, model selection, credentials and memory are owner-selected
instance data. Keep them outside this shareable repository.
Use `cto/` for the shared runtime and `experts/` for specialist templates.

Use $HOME/scratch on the host and /scratch in the container for builds, compiler
caches, downloads, profiling traces and temporary task artifacts. Reuse owned caches;
never move a cache in use or delete another task's work. Use the leased task-workspace
helper for cleanup, save a handoff first, and preserve unfinished/source work.

Run `python3 -m unittest discover -s tests` and
`node --test tests/test_opencode_plugin.mjs` inside the container. Use explicit file
paths when staging; do not stage instance data, runtime metadata or local receipts.

The host boundary is controlled outside the container. Container sudo does not grant
host sudo. Optional NixOS account changes need ordinary owner activation; never use
a container engine as a workaround for missing host administrator authentication.

The CTO owns context preparation for each task. Read the fleet-context skill, select
relevant verified project evidence and lookup hints, and budget for the actual model.
Keep required acceptance checks intact; improve briefs from worker feedback.
