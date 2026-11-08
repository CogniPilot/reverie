# Perf before pane startup

The selected `task-v2` branch runs inside the existing one-shot cold commit,
after actual started-container memory configuration and before a cold token can
reach pane startup. Unselected and legacy `task-v1` paths retain their behavior.

One original twenty-second ceiling covers native inspections, fixed artifact
reads, code hashes, guest execution and readback; runtime cancellation and the
original stop deadline remain additional fences. The actual Creation record
stores the init pidfd and guest-root directory owner before opening/effects.
Normal completion and both original cleanup paths close those same owners.
Consumed-close uncertainty remains sticky. A lost daemon-exec acknowledgement
retains the actual Created record even if the local Docker client was reaped.

The host compares the same actual CID/image/user/init start, selected seccomp
profile and kernel memory limits. It rejects privileged/writable/shadowed code,
hashes the checker, perf and libraries against its compile-bound capsule, then
checks the same incarnation after real stat/record/report. The fixed static
checker result is bounded data with an exact fresh nonce and expected UID.

This phase supplies no pool grant, protected authorization, admission release or
CLI acknowledgement. The application must still join the actual installed pool
member and its protected operation. Production image/host-flow execution tests,
independent review and fleet canary qualification remain required.
