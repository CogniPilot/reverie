# Native worker child

Linux-only fixed guest helper. `reverie-worker-child RECORD` preserves the
existing bare-record interface; `--pane-exit EXIT_RECORD` supervises it and
retains the tmux pane after exclusive exit-data publication. `--help` documents
the fixed root and scope. There is no Python fallback or arbitrary engine API.

Errors settle owned processes before reporting. The shared
`reverie-diagnostics` transport offers bounded best-effort metadata without
blocking on a full stderr pipe/socket; diagnostic delivery never acknowledges
cleanup or changes the original failure result.

The candidate `nix build .#workerNativeChild` is not selected into worker images.
The [lifecycle owner](../reverie-host/src/worker_child/README.md) documents exact
compatibility, intentional parent/receipt hardening, retained uncertainty and
the remaining host admission/effect consumers.
