# Explicit versioned rootless task perf image acceptance

`cargo xtask verify-worker-perf --rootless-image ... --task-perf-policy task-v2`
selects full ordinary multithreaded recording. The thin task only invokes the exact
ignored Host test with its declared image, provenance, policy, Docker-tools,
Coreutils and closure inputs. Xtask contains no engine/policy/resource logic.
No test is part of the ordinary suite unless explicitly selected.
The default selector remains the legacy restricted task-v1 case, which cannot
satisfy this full recording workflow. Its inherited-record refusal is a policy
restriction, not a host limitation or successful capability test. The explicit
v2 case refuses a v1 manifest rather than falling back.

The Rust fixture checks the loaded actual Engine image ID against the declared
immutable worker-image provenance's selected configuration and every RootFS
diffID. Archive config digest and Engine image ID are distinct facts. It uses
the shared real task-v1 projection/verification and rootless argument producer,
then creates one uniquely named disposable container under the normal numeric
user1000:100, CapDropALL plus SETUID/SETGID only, selected seccomp,
systempaths=unconfined, the fixed TUN device and normal rootless runtime tmpfs.
It preserves the rootless helper's no-NNP requirement. It mounts only the
declared read-only public Nix closure, bound test ELF and its own tiny inputs;
home/data/runtime are disposable tmpfs, with no company/employee directories.

The actual guest checks UID/GID, caps and seccomp, then waits while the parent
checks the original CID, actual running state and physical cgroup readbacks:
1536MiB hard RAM, swap0, pids512, no CPU quota and effective CPUs0-7. Only then
does it profile the fixed finite native Rust workload using real per-task
user-space perf stat, record and report, requiring positive counts and samples.
The ordinary recording command explicitly inherits into the Rust workload thread. It uses
the ordinary per-CPU buffers with 64 pages each; `--per-thread` would disable
inheritance and miss that thread. Each completed stat/report is logged before
the next phase so a later refusal preserves the earlier actual measurements.
Task-v1 correctly denies ordinary per-CPU/inherited recording; its negative
result is not a kernel-unsupported pass. Task-v2 tests the separately versioned
nonnegative-task/closed-flags policy without widening v1 or enabling CPU-wide perf.

It also starts the separately prepared immutable rootless Docker package,
checks its real rootless info/VFS driver and kernel socket peer/sub-ID maps,
imports a Rust-built directories-only rootfs, and runs the declared immutable
native Coreutils true from a read-only closure in one inner nonroot container.
The inner workload proves daemon/container functionality; it is not itself
perf-profiled and no inner cgroup enforcement claim is made. The outer bounds
remain in force. Existing packaged rootless/runc Bash wrappers are still used;
this test introduces no first-party shell/Python/JS runner or shell evaluation.

Known body failures stay failures while the actual outer fixture caller tries
one checked original-CID stop/inspect/remove and exact native client cleanup.
Unknown create replies, native/daemon outcomes or consumed descriptor closes
remain retained; no name lookup becomes destructive authority. Host settings,
sysctls, NixOS, production policy and employee state are never changed. Package
or runtime refusal is never reported as a passed unsupported skip. CI may record
an actual platform limitation explicitly, but this strict test still fails and
provides no perf/readiness/rollout success for that platform.
