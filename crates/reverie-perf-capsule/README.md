# Perf guest capsule producer

Build-time Rust assembler for static `reverie-perf-check` and
`reverie-worker-init` executables, plus an immutable, relocated perf ELF closure
at `/opt/reverie/perf`. It shares dependency resolution and loader hardening with
the memory capsule. Shell wrappers, dynamically linked init/checker entry points,
and architecture mismatches are refused. The explicit `--worker-init` input is
mandatory; the output uses `reverie-perf-guest-capsule-build-v2`, with all three
binary input/output hashes and the library/notice inventory. Prior v1 artifacts
remain distinct. The builder makes the output read-only.

This is an unselected image factory. Building it does not authorize a rollout or
prove guest execution. The launcher must execute the checker against the actual
created container and bind the result to its image, process incarnation, selected
policy and nonce before opening a pane. The launcher must separately verify that
the actual PID1 runs this sealed init rather than `/bin/sleep` from writable
`/nix`. Native qualification remains required; no default image is selected here.
