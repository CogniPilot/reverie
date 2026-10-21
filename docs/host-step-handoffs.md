# Reducing manual host work

Status, 2026-10-17: documentation for CTO review. No host installation, image build,
restart, configuration activation or cleanup is authorized by these notes.

Every manual step needs an owner, reproducible inputs, acceptance evidence and a
takeover path. Prepare and test inside the container wherever possible. Keep the
remaining external operation small; do not obtain self-sufficiency by granting
agents a host engine socket or administrator access.

| Manual work today | Takeover owner and next step | Evidence and procedure |
|---|---|---|
| Recover deployed console/runtime deltas for an image | Runtime engineer reconciles source, manifests exact inputs and supplies an independently reviewed candidate | [Image checklist](image-rebuild-handoff.md), items 1–7 and 11; fresh manifests replace historical carry trees |
| Install browser OS dependencies in the live layer | Image supplies reviewed package list; agents install pinned browsers in their own cache and run isolated checks | [Browser testing](browser-testing.md); both engines pass as runtime user; no host package install next time |
| Supply OMC from the host | Runtime engineer completes tested single-user Nix setup, then image reproduces that setup; agents use pinned flakes themselves | [OMC transition](openmodelica-runtime.md) and image item 10; host-registration export is already complete, not a recurring task |
| Add GPU tooling/device access | Owner activates reviewed host toolkit with ordinary authentication; runtime engineer prepares image/helper and runs Light acceptance | [GPU plan](gpu-container-plan.md); reviewed owner steps in the private handoff; no lease/MPS/monitor or public access |
| Recreate the container and resume agents | Runtime engineer supplies complete reviewed deployment package; CTO grants window; host operator performs only bounded engine/service cutover | [Cutover handoff](host-recreate-handoff.md); current identities/native threads, durable mounts, one watcher and retained rollback |
| Recover a failed local agent or restore bindings | Runtime engineer maintains tested runtime watcher and supported console recovery flow | [Watcher design](runtime-watcher.md) and [identity design](durable-identity.md) are historical design notes; verify actual deployed behavior and owner-auth gates before automation |
| Receive ops and report results | Agents mention the configured host identity in its approved channels; active CTO records approval for delegated host operations | Existing configured host bridge/profile; a mention wakes the host identity but is not itself approval; no private profile/token contents in source or chat |

Tracked prerequisite **RECREATE-001** is OPEN, assigned to the runtime engineer:
build the candidate before stopping production and retain the old container/image.
It blocks the next recreate; see the acceptance criteria in the
[cutover handoff](host-recreate-handoff.md). The private instance handoff records
the assigned person, actual paths, access routes, schedule and current deployment.

The Nix how-to and permanent image patch are still pending, as is owner host-toolkit
activation. Preserve the OMC stopgap until the CTO provides an owner-approved removal
scope after Nix acceptance. No additional closure copies, re-unpack automation or
deletion follows from this handoff.

For every later manual operation, add or update its short procedure with inputs,
current review/approval, backup/rollback, exact acceptance and the remaining host
boundary. Store private configuration and receipts in the external instance handoff;
keep portable instructions and source review evidence in this repository. Scratch
contains disposable builds/caches/worktrees, never the sole durable recovery record.
