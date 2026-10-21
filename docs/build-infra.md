# Shared-container builds

The live container has a 4 GiB memory limit and no swap. On 2026-10-15 the OOM killer
took the CTO pane during an unbounded test run. Every compile or heavy test goes
through `cto.buildenv`. Only start one after the coordinator has granted a slot.

```sh
python3 -m cto.buildenv --project rumoca --repo /scratch/repos/rumoca \
    --expect 2.5G --disk 6G [--jobs 2] -- cargo build -p rumoca
```

- **Toolchain:** rustup 1.29.1 (sha256-verified) in `/scratch/cache/rust/{rustup,cargo}`,
  with `nightly-2026-02-27` (rustc 1.95.0-nightly 6a979b3e3), `llvm-tools-preview`,
  `rust-src`, `wasm32-unknown-unknown` and `wasm32-wasip2`, matching every rumoca
  checkout's `rust-toolchain.toml`. Nothing is added to PATH or shell profiles. The
  wrapper sets `RUSTUP_AUTO_INSTALL=0`, so a different pin is refused rather than
  silently downloaded. Install a new pin deliberately (and gated, see below).
- **Before start:** memory admission (`cto.admission`; used memory excludes reclaimable
  page cache, with a 512 MiB reserve), task headroom (`pids.max - pids.current` must cover
  ~32 + 16 x `--jobs` threads plus 64 reserved for other sessions; rustc otherwise dies with
  `failed to spawn work thread: EAGAIN`), free disk minus `--disk` must stay above 20 GiB,
  and an exclusive lock on `/scratch/build/<project>`, so there is one build per target
  dir. Refusals exit 75. `--wait SECONDS` queues instead: memory, pids and disk are
  rechecked every 10 s until they pass or the wait runs out (a held target-dir lock is
  still refused at once, as are a bad project name, a missing toolchain and a pids limit
  too small for the build plus reserve: `pids-limit:`). A wait shorter than 10 s still
  rechecks once at its deadline, and refusals record `waited_s`. The ledger's
  `peak_pids_delta` is the shared cgroup's task growth during the run, so other sessions count too.
- **During the build:** `CARGO_TARGET_DIR=/scratch/build/<project>/cargo`,
  `TMPDIR=/scratch/tmp` and `CARGO_BUILD_JOBS` (default 2, max 8). A watchdog stops the
  build's process group when the cgroup has less than 256 MiB left, before the kernel
  picks an agent session.
- **After:** `/scratch/profiles/build-ledger.jsonl` records three figures:
  - `peak_mib`: the whole build. It is the RSS summed over the build's process group from
    `/proc` at each watchdog tick, and never below the largest single process. Estimate from
    this one. It errs HIGH, because shared pages (libraries, shared memory) are counted once
    per process. It also misses any child that leaves the group with `setsid`/`setpgid`
    (cargo, rustc and npm do not).
  - `peak_rss_mib`: the largest single process (`wait4`). On its own it understates parallel
    builds: a 2-job smoke build showed 63 MiB here against a 108 MiB tree.
  - `peak_cgroup_delta_mib`: an approximation. It is the growth of the container's SHARED
    cgroup during the run, so other sessions' activity counts too. It uses the admission
    measure (`memory.current` minus reclaimable `inactive_file`), so inactive page cache is
    excluded and active cache is not. `null` when the cgroup could not be read.

  A warning is recorded when `peak_mib` exceeds `--expect`. `--expect auto` uses the
  largest `peak_mib` of earlier *successful* runs of the same project and the same command:
  - runs at the same `--jobs` are used as measured;
  - otherwise runs at fewer jobs are scaled up linearly (never down from more jobs);
  - then +25%, at least 256 MiB.

  It refuses when there is no such run yet. Never lower an estimate to get past the gate.
- **Heavy non-cargo steps** (installs, test runners) use
  `python3 -m cto.admission --expect SIZE -- CMD`. IO-heavy steps also fill the page cache.
  The toolchain install hit the cgroup limit for 11 s (reclaim only, no kill) at a
  measured 522 MiB peak.
- **OOM timeline:** `/scratch/profiles/oom-watch/oom-watch.sh` logs every
  `memory.events` change with a timestamp and the top processes to
  `/scratch/profiles/oom-watch/events.log`.
