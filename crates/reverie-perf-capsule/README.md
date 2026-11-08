# Perf guest capsule producer

Build-time Rust assembler for a static `reverie-perf-check` and an immutable,
relocated perf ELF closure at `/opt/reverie/perf`. It shares dependency resolution
and loader hardening with the memory capsule. Shell wrappers and dynamically
linked checker entry points are refused. The build records input/output hashes
and retains upstream notices, then makes the output read-only.

This is an unselected image factory. Building it does not authorize a rollout or
prove guest execution. The launcher must execute the checker against the actual
created container and bind the result to its image, process incarnation, selected
policy and nonce before opening a pane. Native qualification remains required.
