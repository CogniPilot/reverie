# Fixed worker init

This Linux-only, single-threaded binary is the sealed task-v2 PID1. It accepts no
arguments, launches no process and never execs another program. The image capsule
builder requires a static executable with the same architecture as perf/checker;
the host must separately bind its actual PID/executable/hash to the real creation.
Its presence is not readiness, a pool-membership proof, or resource authority.

SIGTERM, SIGINT and SIGCHLD are blocked before a close-on-exec signalfd is opened.
PID1 reaps adopted exited children in batches of at most 256 nonblocking waits,
checking for stop between batches. TERM/INT exit the namespace init immediately;
Linux then terminates remaining namespace members. No process-group signalling,
child-selected program, grace extension, signal handler, thread, or self-exec is
available. The bound is on work between checks, not kernel/scheduler latency.

Linux preserves blocked signals before its PID1 default-disposition ignore check:
[kernel signal.c, sig_ignored](https://github.com/torvalds/linux/blob/v6.18/kernel/signal.c#L100-L118).
The constructor runs only in the disposable namespace PID1, so it retains its
signal mask until process exit; it never mutates the broker's masks.

Pure invocation tests do not prove namespace signal delivery or orphan reaping.
Those require separately reviewed owned native namespace/container controls.
