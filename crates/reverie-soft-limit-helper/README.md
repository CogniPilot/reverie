# Reverie soft-limit helper

This Linux Rust executable replaces the former Python root helper. Nix packages
it as `softLimitHelper`, and the existing `reverie-soft-limit@` socket service
invokes it with fixed owner-installed arguments. Its runtime closure contains no
Python interpreter or broker source. There is no fallback implementation.

Each accepted Unix connection carries one bounded JSON line containing exactly
`v`, `sessionId` and `containerId`. The peer UID, deployment, engine, engine socket,
policy file and state root are pinned by the service. A request cannot select a
path, command, employee, limit or cgroup.

The root-owned policy binds each employee home to one hard/soft RAM pair and the
qualified kernel release. Before a write, the helper checks policy custody,
engine identity, home binding, actual hard limit, PID birth, full host cgroup2
mount, and a descriptor-anchored cgroup leaf. The engine reinspection precedes a
fresh local fence and final deadline check. The helper opens `memory.high` with
`O_NONBLOCK` and makes exactly one write syscall.

Every error after opening the writer is `EFFECT_UNCONFIRMED`, including a partial
write, interrupted syscall, identity drift, readback mismatch or close failure.
The caller must inspect the outcome; it must not retry or roll back an uncertain
operation. A success confirms only this policy-selected soft threshold, not a
pool expansion, a hard-limit change or an employee rollout.

Unsafe Linux syscalls are confined to `src/os.rs`. Application logic retains the
workspace's strict unsafe-code and Clippy rules. Test-only fault injection and
owned fixture roots have no command-line or wire equivalent.

Run the workspace checks in the native environment:

```sh
nix develop --command cargo fmt --all --check
nix develop --command cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
nix develop --command cargo test --locked --workspace --all-targets --all-features
nix build .#softLimitHelper
```

Keep `CARGO_TARGET_DIR` in task-owned temporary storage. Tests use owned fake
process/cgroup/policy trees, Unix socket pairs and harmless fake engine processes.
They never write host cgroups or call a real engine. A successful package build
and fixture suite do not constitute a native host activation or canary.
