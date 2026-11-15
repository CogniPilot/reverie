# Native memory.high helper acceptance

`cargo xtask verify-memory-high-helper --ci` is a required image-workflow job on disposable GitHub-hosted Ubuntu. It builds the maintained static helper factories under fresh CI-only names, loads their archives and obtains actual immutable image IDs from Engine inspection. It does not treat an archive/config hash as a Docker image ID. No Console, GPU image, provider account or company directory is needed.

The canary creates a new random Docker-owned Box, inert anchor and inert worker. Only that new parent/leaf receives writable cgroup mounts. Helpers have no Engine socket, network, capabilities or writable root filesystem. The worker stays at the same PID, birth and inode while the high-only helper raises memory.high from 64MiB to 128MiB and restores 64MiB. Every other reported hard/CPU/cpuset limit and identity must remain exactly equal. A real CPU-weight mismatch must fail without changing memory.high. The baseline helper remains separate and its full Engine image descriptor must stay unchanged.

Every CREATE/START has a durable intent and immutable CID before dependent actions. Unknown results fail; no helper/provider action is replayed. Cleanup revalidates the exact recorded image/CID/nonce/role and any running init birth, stops/removes only owned canary containers, and checks absence without interpreting localized CLI error text. A cleanup failure fails the job and retains evidence; there is no broad prune or label-only deletion. Native success is emitted only after checked evidence closure.

For a local isolated run with already qualified images and a new private evidence directory:

```text
cargo xtask verify-memory-high-helper --baseline-image sha256:BASELINE --writer-image sha256:HIGH_ONLY --evidence /owned/new/evidence
```

The image arguments must be full actual Engine IDs, not the placeholders above. This mode never builds or loads images and never selects company workers. It requires Linux x86_64, Docker's systemd cgroup-v2 driver and the fixed helper image contracts. Unsupported platform/kernel results fail rather than skip.

Pure guard tests are separate from this actual kernel acceptance. This job proves neither real company/agent authorization nor self/team plan moves, resource API approval, model launch or the complete fake-office workflow. Those remain separate required product/office acceptance work.
