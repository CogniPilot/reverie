# Build-only policy artifacts

`reverie-policy-artifacts` is the Nix task-v1 seccomp artifact producer. It is
not installed in the server runtime and is not an owner configuration or
deployment interface. The existing GUI/API and broker continue to own those
operations. `--help` describes the fixed outputs, accepted target systems,
build-only input paths and failure behavior.

The executable delegates policy, whole-base derivative, JSON bytes and hashes
to `reverie-contracts::task_perf_v1`, which in turn uses the checked core rule.
It writes the same sorted, default-spaced ASCII JSON plus newline as the legacy
producer. Only the seven existing manifest fields are emitted. The declared
paths are build data; installed observation separately proves canonical Nix
paths, actual system, custody, both raw hashes and the derivative.

Input and output are bounded to the installed reader's 65536-byte limit. Existing
output leaves and symlinks are refused, never truncated. Each opened descriptor
is closed once with errors checked; both primary and close errors survive.
Failed builds can leave partial, unpublished files. Nix publishes only a
successful derivation; the program never cleans or adopts another build's data.

`nix/policy-artifacts.nix` projects the three actual crate inputs and the
transitive Cargo lock closure. Unrelated workspace members, lock entries, host
code and website files do not change this producer's identity. Changes to an
actual policy/producer dependency or toolchain intentionally do. The initial
Rust migration changes the output store pathname; profile bytes, raw hashes,
manifest schema and location-dependent manifest formatting remain compatible.

The old `nix/worker-perf-profile.py` was retired after byte qualification against
its historical source at `77c4c1a7`; sealed oracle fixtures and receipts retain
that provenance. The current Python broker and the separate Docker base-profile
producer still need migration. Nix's third-party TOML generator and other build
tools can themselves use Python; this cohort removes the selected first-party
task-perf producer, not every build-time interpreter. No deployment, engine
operation, perf syscall or service-runtime Python removal is claimed here.
