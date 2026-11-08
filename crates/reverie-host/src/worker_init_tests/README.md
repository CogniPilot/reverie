# Owned static PID1 semantics fixture

The ignored `worker_init_tests::actual_static_pid1_adopts_reaps_and_handles_term_int`
test creates two sequential, fresh fixture containers, using TERM and INT once
each. No company mounts, profile/configuration files, registry pulls, pool-limit
writes, host namespace entry, host settings, or production operations occur.
The three other ignored selectors are fixed contained Rust probes, not user
program endpoints. They refuse the host before spawning or exiting a process.

Inputs are separately frozen and independently reviewed before execution:

- `REVERIE_INIT_FIXTURE_CAPSULE`: the actual qualified capsule-v2 Nix output.
  The inventory and static init bytes are read through checked native readers;
  the init SHA must equal that immutable inventory. Static ELF qualification
  belongs to the pinned Nix build/independent artifact receipt, not ELF magic.
- `REVERIE_INIT_FIXTURE_IMAGE`: the actual loaded immutable Engine image ID
  produced by `nix/worker-init-fixture-image.nix` with that capsule. Before any
  container create, actual image inspection must show the fixed entrypoint,
  `1000:100`, and null or empty Cmd. Legacy sleep images are refused. No loaded
  image is edited to clear its command, and no tag is used as identity.
  Before import, archive preflight must inspect final entries across all layers:
  every capsule ancestor is a real root-owned directory and every capsule code
  file is a root-owned, read-only regular file with the exact pinned SHA. No
  symlink, hardlink or whiteout may replace these entries. All code bytes must
  match the qualified capsule. Config-only image validation is insufficient. The
  regular-layout r2 tag is distinct from the preserved failed symlink image.
- `REVERIE_INIT_FIXTURE_CLOSURE`: explicit JSON public Nix closure paths for the
  copied Host test ELF's interpreter/libraries. Only complete canonical store
  roots are bound read-only; no personal data is included.

The init, copied test ELF and public Nix paths are read-only binds. Containers
run with no added capabilities, no-new-privileges, private PID namespace,
read-only root, network none, 512 MiB hard memory, swap zero, 64 tasks, one CPU
quota and effective cpuset 0-7. This fixture quota is not the employee soft-CPU
policy. Actual Engine and kernel limits are checked before the probes.

The fixed parent deliberately exits after starting its single contained child.
The child waits for actual PPid 1 before publishing its marker. The observer
checks that live parent relationship, pins that original child with pidfd and
start tick, then releases it. Success requires the original process to vanish
from proc **and** its pidfd to report death, followed by checked pidfd close.
This proves adoption/reaping; it does not claim an orphan exit status.

Each original CID is retained separately, with durable unique-name/attempt,
raw successful create stdout before parsing, and original-CID receipts. TERM or
INT must yield exit 0 within five seconds, before cleanup. On a failure, cleanup
may kill only that exact original CID once; that cannot turn a failed signal
assertion into a pass. Unknown CLI/descriptor outcomes remain sticky, retain
the original CID and fixture directory, and prevent a removal acknowledgement.
There is no name-targeted cleanup or automatic retry of an ambiguous create.

The image contains the sealed capsule for reproducibility, but this test uses a
fixture-only init bind. It is **not** the production sealed-prefix observer,
before-pane perf consumer, physical InstalledPool proof, admission/registration
authority, service readiness, or rollout acceptance. New native execution needs
its own exact-source/artifact/effect PREEXEC review.

The contained parent and observer use the closed test-only
`reverie-init-fixture-probe-v1` reply. Each invocation binds the exact phase,
original container hostname and fresh random nonce. Actual executable path,
fixed marker, phase and correlation checks run outside the semantic panic
capture, so invoking these ignored tests on the host fails normally. A helper
CLI exit of zero means only that a typed reply was delivered. `refused` always
fails the outer owning test; missing/malformed/mismatched replies and
`unconfirmed` retain uncertainty. After the parent has announced its actual
child, every observer refusal also retains uncertainty about that child; a
local observer error cannot establish closure of the child’s private native
owners. Only the full positive reap/checked-close result ends that phase. No generic error string is parsed as evidence
of native closure. Checked reads, marker closes and the original orphan pidfd
share one sticky native-close latch; an unclosed original pidfd is retained and
marks the reply unconfirmed before it is forgotten. The parent intentionally
orphaning its single fixed child remains contained by the original CID owner.
