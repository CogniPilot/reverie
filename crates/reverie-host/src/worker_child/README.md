# Fixed guest child lifecycle

This module implements the in-worker `worker.child` operation and a native pane
supervisor. `WorkerChildRuntime::installed` chooses the fixed guest record root,
model/office relays, shim and Bash. There are no production path/program/env
override knobs. It changes process-global signals, umask and cwd and is intended
for the standalone helper, never an embedded multithreaded broker.

The private record reader preserves UTF-8 `read_text` universal-newline decoding,
default JSON last-wins/numeric behavior, no raw file bound, hardlinks, and lazy
field processing. The record is decoded and unlinked before environment values
are interpreted. Post-broker environment data is unrestricted; public request
allowlists remain a separate owner. Temporary paths use the raw cwd fsencode
bytes. Final native argv/environment encoding preserves surrogateescape bytes,
ordering and NUL/invalid-name refusal.

The held parent and leaf anchors pin identity and prevent inode reuse during
checks. Parent ownership and group/world-write refusal are a deliberate narrow
hardening over the original child; owned 0755 parents remain supported. These
checks are observations in a trusted private namespace, not atomic protection
against arbitrary same-UID renames. No path data supplies owner or start authority.

Two retained process slots cover the fixed model/office relays. The pane instead
uses one slot for the same installed executable's record mode, inherits stdio,
publishes the paired exit data and remains alive. Constructors have a 20-second
bound; the first stop establishes one 34-second ceiling. Timed-out constructors
retain their exact context. Signals and waits use the child's transferred pidfd,
never numeric PID or process-group fallbacks. Uncertain descriptor/signal
finalization remains fenced even on repeated `finish` calls. Dropping a context
is not an acknowledgement. Successful exec transfers the fixed relays to the
guest/container lifecycle; it does not certify provider shutdown.

Exit publication creates an exclusive private temporary file, fsyncs and closes
its writer, checks its pinned identity, uses no-replace rename, fsyncs the held
directory and reads back exact bytes. An existing receipt or temporary leaf is
retained. Publication/close uncertainty never permits rollback or retry. The
old shell wrapper overwrote a receipt; the new path deliberately refuses that
case because the broker's fresh nonce is the required caller invariant. Exit
data is a command outcome, never an admission or cleanup permit.

The actual model/office relay entrypoints currently run the existing Node relay
implementation. This module preserves those fixed invocations and does not
claim the entire worker runtime has become native. The candidate Nix package is
unselected; the existing Python broker/child and shell pane wrapper remain
migration debt until their actual preparation/admission consumers move together.

The remaining host lifecycle includes retained launch-record production under
the real Gate preparation/baseline handle, engine create/start/memory enforcement,
tmux preparation/attach, group-owned viewer shutdown and broker/client registry
cleanup. `WorkerCreatePlan`, `StoragePaths`, record bytes and exit data cannot
construct their future effect permissions. No callback or boolean grant is
provided by this guest module.
