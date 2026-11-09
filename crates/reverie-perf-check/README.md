# Employee perf check

This Linux guest command runs only from its fixed read-only image path,
`/opt/reverie/perf/bin/reverie-perf-check`. Its fixed profiler, loader and
libraries must be packaged beside it outside the laptop's writable Nix store.

It checks ordinary credentials, zero effective/permitted capabilities,
seccomp and unchanged `perf_event_paranoid`; runs real software counting,
inherited recording and report; and requires positive samples with zero loss.
The workload uses two Rust threads for 750 milliseconds. A fixed environment
and private workspace prevent user perf configuration from changing the check.
Original captured processes, pipes, directory ownership and signal state must
settle before a successful result is printed. Unknown cleanup stays negative.

The JSON nonce/result is data. Only the real host launch owner can join its
actual execution to the same Created CID/PID/start, selected policy, memory
readback and physical pool membership before pane startup. This consumer and
native image qualification are still required; this source is not readiness.
