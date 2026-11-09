# Native worker child

Linux-only fixed guest helper. `reverie-worker-child RECORD` preserves the
existing bare-record interface; `--pane-exit EXIT_RECORD` supervises it and
retains the tmux pane after exclusive exit-data publication. `--help` documents
the fixed root and scope. There is no Python fallback or arbitrary engine API.

Errors settle owned processes before reporting. The shared
`reverie-diagnostics` transport offers bounded best-effort metadata without
blocking on a full stderr pipe/socket; diagnostic delivery never acknowledges
cleanup or changes the original failure result.

The runtime and worker image builds select this native helper through
`workerChild = workerNativeChild`. `cargo xtask verify-worker-child-package`
qualifies the public selected artifact and its `--pane-exit` interface. This
package selection does not upgrade already-running worker images.
The [lifecycle owner](../reverie-host/src/worker_child/README.md) documents exact
compatibility, intentional parent/receipt hardening, retained uncertainty and
the remaining host admission/effect consumers.
