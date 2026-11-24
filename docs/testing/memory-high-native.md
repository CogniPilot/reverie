# Native memory.high helper acceptance

`cargo xtask verify-memory-high-helper --ci` is a required image-workflow job on disposable GitHub-hosted Ubuntu. It builds the maintained static helper factories under fresh CI-only names, loads their archives and obtains actual immutable image IDs from Engine inspection. It does not treat an archive/config hash as a Docker image ID. No Console, GPU image, provider account or company directory is needed.

The canary creates a new random Docker-owned Box, inert anchor and inert worker. Only that new parent/leaf receives writable cgroup mounts. Helpers have no Engine socket, network, capabilities or writable root filesystem. The worker stays at the same PID, birth and inode while the high-only helper raises memory.high from 64MiB to 128MiB and restores 64MiB. Every other reported hard/CPU/cpuset limit and identity must remain exactly equal. A real CPU-weight mismatch must fail without changing memory.high. The baseline helper remains separate and its full Engine image descriptor must stay unchanged.

Every CREATE/START has a durable intent and immutable CID before dependent actions. Unknown results fail; no helper/provider action is replayed. Cleanup revalidates the exact recorded image/CID/nonce/role and any running init birth, stops/removes only owned canary containers, and checks absence without interpreting localized CLI error text. A cleanup failure fails the job and retains evidence; there is no broad prune or label-only deletion. Native success is emitted only after checked evidence closure.

For a local isolated run with already qualified images and a new private evidence directory:

```text
cargo xtask verify-memory-high-helper --baseline-image sha256:BASELINE --writer-image sha256:HIGH_ONLY --evidence /owned/new/evidence
```

The image arguments must be full actual Engine IDs, not the placeholders above. This mode never builds or loads images and never selects company workers. It requires Linux x86_64, Docker's systemd cgroup-v2 driver and the fixed helper image contracts. Unsupported platform/kernel results fail rather than skip.

The same hosted job builds a separate acceptance bundle from the production historical-helper reader and the console’s locked dependencies. It checks that the bundle contains the actual reader and no resource-store, runtime or launch owners. A second fresh Box issues a canonical helper which refuses before changing limits, stops only its own inert worker, and verifies original-helper closure through Docker inspection alone. The result remains an unknown original outcome, never a current policy ACK. The CLI success sentinel and checked cleanup are mandatory. No console service is started.

Pure guard tests are separate from this actual kernel and stopped-worker acceptance. This job proves neither real company/agent authorization nor self/team plan moves, resource API approval, model launch or the complete fake-office workflow. Those remain separate required product/office acceptance work.

## Explicit populated-pool restoration

`docker-pool-restore-helper-image` is a separate immutable image selection. It
does not replace the deployed anchor or baseline helper image. The fixed
`restore-pool` command accepts the same explicit parent identity and approved
pool limits as `configure-pool`, plus every live member as
`--member FULL_CID:HOST_PID:BIRTH_TICKS`. It requires a nonempty, unique member
set with births, an explicit CPU set, and the original root/FD/cgroup/process and
thread membership checks before, between and after writes. `configure-pool`
continues to refuse populated pools. Neither command stops or recreates workers.

The distinct restore ACK contains the normal pool observation and all observed
member identities. A successful command still requires consuming descriptor
closure. Unknown CREATE/START results must be inspected as their original
attempt; they do not authorize another helper invocation.

The optional protected runtime `poolRestoreHelperImageId` selects only the new
pool ACK reader. Existing pool reconciliation can adopt a genuine terminal ACK
after rechecking its exact immutable image, fixed configuration, complete
current members, approved policy, native epoch and full closed writer census.
It writes correlation through the existing canonical writer, never kernel
limits or old task phases. Strict observation version 2 retains the original
anchor image separately; version 1 remains supported. This source/component
coverage is not evidence of an actual populated-kernel restoration; that must be
qualified on the selected image and original native attempt.

## Group CPU ceiling on a populated pool

The fixed `configure-pool-cpu-max` command takes the same parent identity,
approved pool limits, explicit CPU set and birth-bound `--member` list, plus
`--cpu-max-cores N` (whole CPUs, at most the pool CPU set) or
`--cpu-max-cores max`. It requires every other pool limit to already equal the
declared policy, writes only `cpu.max` as `<N x 100000> 100000` (or
`max 100000`), reads it back and repeats the membership checks around the write.
It accepts an empty or a populated pool and never stops or recreates a worker.
Its ACK (`reverie-boxed-pool-cpu-max-ack-v1`) carries the pool observation and
the observed members.

No helper image carrying this command is selected yet and the console does not
issue it. The component tests exercise owned regular files, not a kernel; an
actual write must be qualified on its own selected image, like the commands
above. The owner approval and status API is described under
[owner operations](../owner-operations.md#employee-group-cpu-ceiling).
