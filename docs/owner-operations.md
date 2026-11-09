# Owner operations

The canonical architecture and implementation gaps are in
[SPEC_0001](../spec/SPEC_0001_OWNER_OPERATIONS.md).

The [employee resource rollout API](owner-resource-rollout.md) documents the
shared GUI/API contract and its current host-installation blockers.

See the [specification index](../spec/README.md) for DRY, crate boundaries,
valid-by-construction contracts, review and workflow rules. The
[Rust overhaul inventory](rust-overhaul.md) tracks migration work.

Console deployment previews and the final pre-stop check refuse observed writable
mounts from other running containers that overlap the console data, including
parent paths and resolved symlink aliases. `DEPLOYMENT_SHARED_WRITABLE_MOUNT`
means the shared writers need coordinated lifecycle maintenance before a fresh
preview. The updater never stops those writers implicitly. This early check is
an observation, not a whole-host writer-exclusion guarantee; the existing byte,
metadata and restore-rehearsal checks remain required.

This follows Docker's documented [bind-mount write semantics](https://docs.docker.com/engine/storage/bind-mounts/).
Docker's [container commit](https://docs.docker.com/reference/cli/docker/container/commit/)
pauses the selected container and excludes mounted-volume data, so an image
commit cannot provide this shared-data backup. Coordinated shared-writer
quiescence remains a product workflow requirement.
