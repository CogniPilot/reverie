# Read-only engine metadata client

The installing service supplies `EngineBootstrap`, never a request. It captures
the selected Docker/Podman executable, its original argv0, working directory and
full native environment once, including endpoint/context/runtime/auth settings.
PATH selection happens at bootstrap; queries do not consult later environment
changes. These are installation data, not a claim that an engine daemon, image,
endpoint or owner permission has been independently authenticated.

`ReadonlyEngine` exposes exactly inventory IDs, inspect batches of 1–32 checked
complete container IDs, and selected stopped-state inspection. Fixed formats
match the existing NativeObserver projection and omit Env, command/arguments
and container logs. Captured metadata and diagnostics remain protected data.
Only successful UTF-8 stdout is returned; stderr is validated and never inserted
into errors. The observer owns one overall deadline of at most 30 seconds and
passes it unchanged to every query. Each command additionally clamps to 20
seconds; stdout and stderr together are bounded at 8 MiB.

One persistent non-Clone context admits at most one active or pending client.
The worker owns a constructor that may itself block; a caller deadline or
cancellation returns explicit uncertainty while preserving that pending record.
Subsequent queries remain fenced, so a stuck constructor cannot create unlimited
spawn threads. Late-created clients are cancelled and remain owned until their
cleanup is confirmed. `settle_owned` uses an explicit lifecycle deadline and
never repeats an engine query or turns its failed outcome into a success.

The Linux syscall boundary creates a private CLOEXEC nonblocking datagram pair.
The child opens a pidfd for itself in a fixed pre-exec callback and transfers
that kernel handle before exec. The callback uses only stack storage and direct
async-signal-safe operations; no inherited Rust mutex or allocator is used.
This avoids a parent PID lookup/reuse race. Signals and nonblocking waits use
that exact pidfd. No numeric PID or process-group signal exists. Unsupported
pidfd kernels/security policy refuse rather than falling back to numeric kills.

Both pipes are read nonblocking and fairly, with deadline/cancellation checks
between bounded chunks. Descendant-held writers keep cleanup unconfirmed; this
client never claims or signals those descendants. Finalizers close owned FDs
once, preserve failures and never retry a possibly reused descriptor. An opaque
close failure keeps the context fenced. Retain the context across failures and
check settlement before shutdown acknowledgement; dropping it only requests
cancellation and is not a cleanup receipt.

Tests compile one controlled Rust child into owned temporary storage. They
exercise exact legacy argv vectors, separate-pipe backpressure and the combined
limit, UTF-8/exit refusal, active cancellation, inherited writers, delayed spawn,
pending-reap admission fencing, close errors, malformed/truncated/multi-FD
handoffs, failed pre-exec/exec, and frozen bootstrap settings. No Python/shell
program is added and no live engine, container, provider, service or mount is
invoked. The current Python broker remains selected until the complete observer
and its consuming admission workflow pass independent integration review.
