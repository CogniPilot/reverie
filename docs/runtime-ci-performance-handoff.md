# Runtime, release CI and page performance handoff

Updated 2026-10-22. The owner asked to hand this work to the agents in Reverie.
This document describes completed work separately from unfinished work. Do not
interpret a staged file or an earlier completion claim as a deployed feature.

## Start here

- Continue in the existing `codex/reproducible-nix-runtime` branch. Preserve its
  staged and unstaged changes; `flake.nix` has both. Do not reset or overwrite them.
- The repository is explicitly mounted in the running container at
  `/projects/reverie`; `/reverie_workspace/reverie` points there. The host checkout
  is `$HOME/git/reverie`.
- Read the root `AGENTS.md`, `README.md` and `apps/web/CLAUDE.md`. Use Nix for
  installation and development. Put large outputs and disposable test data under
  `$HOME/scratch/reverie` on the host, `/scratch` in the container.
- Do not include instance data, credentials, personal memories or recovered
  private backup material in commits or images. Stage explicit paths only.
- Existing draft PR: https://github.com/jgoppert/reverie/pull/33 (base `main`).
  The owner authorized committing, pushing and tagging the finished fixes, and
  watching/fixing CI until green. Merging the PR was not explicitly requested.
- No worker agents were started for this handoff. Do not send messages into
  Reverie on the owner's behalf merely to announce this file.

## Outstanding owner requests

1. Finish reusable local-model setup with Nix, including users with an NVIDIA
   6000. Auto-detect the GPU generation; the exact 6000 generation is unknown.
2. Offer the recovered `jinx-hands` custom harness separately from model selection.
   The current recovery is experimental chat only; coding tools remain unfinished.
3. Run CI on every push and PR; build/publish Docker images on version tags only
   after the tests pass. Commit, push, tag, and monitor/fix the workflows.
4. Improve slow initial loading of Company and Board. Profiling has started;
   no page-performance fix has been made yet.

## Completed, pushed and deployed

HEAD is `78a8f0195725e53705a7a0462832bc3ffd4c6ee6`,
`feat(plans): delegate expert moves through handoff approval`.
The remote feature branch matches this commit. Its existing image workflow passed:
https://github.com/jgoppert/reverie/actions/runs/39749011898 .
This success does not cover the uncommitted changes below or the requested new CI.

Earlier commits include `9a0a30c` (approved cross-provider plan moves) and
`7b04ceb` (Nix-packaged Kokoro, 54 voices, profile voice selection and previews).

Plan delegation is live:

- Employee permissions `moveOwnPlan` and `managePlans` default to false. The owner
  has granted self moves to all current employees, and team plan management only
  to Burt. Titles do not grant permissions.
- An authorized agent requests a move. The exact source expert must approve it
  with a handoff; the normal candidate-session launch and confirmation follow.
  A requester cannot bypass that handoff by directly creating a session.
- API: `POST /api/plans/agent-requests`, then scoped
  `/api/plans/agent-requests/:id/{status,cancel,reauthorize}`.
- CLI: `reverie agent plan-move request ACCOUNT --employee EMPLOYEE --id ID`,
  `status|cancel|reauthorize ID`, and
  `approve ID --handoff-file PATH` from the source expert.
- Delegated moves are disabled in multi-user deployments until provider-account
  ownership can be scoped correctly. Native Codex/Claude moves are supported;
  arbitrary custom-harness migration is not implemented.
- Existing pending requests may need reauthorization after a server restart.
- Verified with 1,316 console tests, 561 Python tests, 36 root Node tests,
  cross-provider API integration, permission revocation and Chromium checks.

Live container `reverie` is running image
`sha256:d9107046929ddc71ad80d5f769e805d5b4a1441811a28811632b65a4f0f4e7de`.
Its immutable source is
`/nix/store/jsl9mn4ksqbbrcdqw9wnj7bx0w7gf2za-source`.
It does **not** contain the new model relay or Hands recovery yet.
The host port is loopback 3000, served through the existing private Tailscale
HTTPS mapping. Preserve the existing deployment rather than replacing its mounts.

Nine experts currently have `desiredRunning: true`. Alex and Vale intentionally
have `desiredRunning: false`; do not wake them automatically. Preserve all owner
authentication state, permissions and desired-running choices during updates.

Previous channel-history recovery and Kokoro restoration are already done. Do not
repeat the history import. Earlier recovery receipts are under
`$HOME/scratch/reverie/receipts/channel-recovery-20261022`.

## Uncommitted local-model implementation

Inspect `git status` before editing. Most new files are already staged, but later
edits may be unstaged. There is an untracked `apps/web/node_modules` symlink to an
owned scratch dependency tree. Remove the symlink before final staging/image
evaluation; do not delete its target or commit the symlink.

Relevant files:

- `apps/host/local-model.py`: Nix launcher, existing GGUF weights, NVIDIA capability
  detection or CPU, private API key, optional persistent user systemd service.
- `nix/local-model-runtime.nix`, `flake.nix`, `flake.lock`: pinned CUDA llama.cpp
  runtime, `localModel` package and `local-model` app. CUDA input is pinned to
  nixpkgs `02f5696b0e6097e589076d886b317b83ff0437d7` (CUDA 12.9).
- `apps/host/model-relay.mjs`: container loopback HTTP 8092 forwards to a private
  Unix socket in the existing control mount, with streaming and cancellation.
- `docker/entrypoint.sh`, `nix/package.nix`: relay and Hands packaging/startup.
- `python/reverie/image_check.py`, `tests/test_image_check.py`: allowlist additions
  for the packaged helpers, not a general relaxation of image scanning.
- `tests/test_local_model.py`, `tests/test_model_relay.mjs`: GPU selection,
  key/mount validation, real socket/HTTP streaming and cancellation tests.

The host `reverie-local-model` user service is active and running. Installed via
`nix profile install .#localModel`; configuration is in
`$HOME/.config/reverie/local-model.json`. Inspect it privately, not in public logs.
Model weights were not modified or downloaded. Existing requested weights are:

```
$HOME/.local/share/opencode/models/Huihui-Qwen3.8-27B-abliterated-UD-DW-Q4_K_M.gguf
```

The alias is `qwen3.8-27b-abliterated`, context 32,768. RTX 3090 native inference
returned `READY` in about 0.3 seconds, using about 16.5 GiB GPU memory. The service
now uses a private socket rather than the earlier temporary TCP probe:

```
host:      $HOME/reverie/runtime/control/models/default.sock
container: /run/reverie-control/models/default.sock
key:       models/api-key within that same private control directory
future container endpoint: http://127.0.0.1:8092
```

Do not print the API key. The socket/key are owner-only. The current image has no
relay yet, so container HTTP 8092 is not ready until deployment. The old
169.254.1.2 endpoint is obsolete; Docker gateway TCP access is blocked by the host
firewall. The private socket avoids needing firewall or GPU-device passthrough.
Do not start the old `opencode-model.service`: it first downloads an unrelated
large model. Do not use Docker to bypass missing host administrator permission.

Remaining local-model work:

1. Verify the persistent service's Unix-socket inference using its private key.
2. Add owner-facing setup documentation: Nix install/run/service commands, existing
   or explicitly downloaded GGUF, driver prerequisites, first CUDA build time,
   CPU mode, endpoint/model discovery and harness selection.
3. Register/enable the endpoint through the supported owner configuration path.
   No claim has been made that the local endpoint is already selectable live.
4. Build/test/scan/deploy the image; verify real model replies through the relay
   inside the container. Preserve current expert identities and memories.
5. GPU detection tests cover SM 8.6, 8.9 and 12.0; only the RTX 3090 was physically
   tested. Do not claim a particular NVIDIA 6000 was validated on hardware.

## Hands recovery

Generic frozen r3 harness sources were recovered from the owner's local backup:

```
/reverie_workspace/lucid/instances/jinx/runtime/handoffs/2026-10-21/mira/generic-harness-loop-r3/source
```

Only generic Python implementation and synthetic tests were copied into
`python/reverie/hands/` and `tests/hands/`. Do not copy personal configs, evidence
or identity files into the public package. Legacy `cto` memory imports were
ported to `reverie`.

`python/reverie/hands/launcher.py` builds a private per-session profile from the
actual employee API record and injected endpoint variables. It uses polling
chat transport. Coding, search, vision and automatic memory ingestion are off.
There is no completed workspace-tool safety integration. Keep the label
`Hands (experimental chat)` honest; OpenCode remains the local coding option.

Harness registration is in `apps/web/src/config/cli-registry/stock.ts` and generated
`apps/web/config/clis.stock.json`. Injected variables are
`REVERIE_HANDS_BASE_URL`, `REVERIE_HANDS_MODEL`, `REVERIE_HANDS_API_KEY`.
The key is not written into generated agent JSON. No personal model choice or
Jinx identity is embedded in the package. Generic custom-model injection for
every arbitrary registered CLI is still unsupported.

Remaining: launcher-specific tests, a real-model/synthetic-chat integration test
without posting to actual company rooms, profile/selection browser verification,
provenance/limitations documentation and final package/image checks. The launcher
captures persona at startup, not on every subsequent profile edit. Review its
startup retry/error handling before calling it production ready.

## Company and Board performance investigation

Read-only live probe issued and revoked a temporary host service token; no room
messages or employee changes were made. Results for three sequential requests:

| Endpoint | Times, milliseconds | Response bytes |
| --- | --- | --- |
| `/api/company` | 9, 2, 1 | 13,700 |
| `/api/board` | 2,793, 11, 8 | 28,495 |
| `/api/plans` | 7, 7, 8 | 4,337 |

The initial Board stall is real, but its exact source is not established. Provider
usage refresh is a suspect because warm requests are fast. Do not claim the
historical arithmetic alone caused that 2.8-second delay.

- `apps/web/src/web/routes/board-routes.ts`, GET `/api/board` around line 225,
  awaits `planBurn()` for an owner response. `planBurn()` around line 300 awaits
  account readings and usage history. It recalculates each historical point using
  `burnRate(samples.slice(0, i + 1), ...)`, giving quadratic history traversal.
- `apps/web/src/plan-accounts.ts`, `rows()` around line 358, awaits all provider
  readers; inspect their cache/refresh behavior for the cold delay.
- History is retained for eight days, sampled about every five minutes.
  `apps/web/src/plan-pace.ts` defines a six-hour regression window, reset/drop/jump
  guards and a minimum one-hour span. Preserve these semantics if optimizing.
- `apps/web/src/web/public/company-plans.html` fetches the full `/api/board` to
  show plans. `chat-app.js` also fetches it for employee work state.
- Company opening is around `chat-app.js:2258`; work refresh is around 2518.
  The plans iframe and people/work path can independently request the same heavy
  endpoint. The Board page itself also uses `/api/board`.

Next: instrument cold provider/history costs, avoid blocking useful page content
on unrelated provider network reads, consolidate redundant initial requests where
appropriate, and add regression checks that preserve authorization and freshness.
Re-measure cold and warm loading after the fix. No performance files were edited.

## Tests and receipts

Completed for the uncommitted work:

- Recovered Hands tests: 82 passed.
- Full root Python suite including Hands/local-model: 646 passed.
- Socket relay tests: 2 passed, including streaming/cancellation.
- CLI schema/catalog/spawn/local-profile/hire tests: 102 passed in five files.
- Generated CLI catalog and typecheck passed before the last small edits.

Logs are under `$HOME/scratch/reverie/models/`, including `hands-tests.log`,
`python-tests.log`, `relay-tests.log`, `catalog-tests.log` and `first-reply.json`.
Re-run appropriate checks after finishing the changes.

A new full `npm test` run was started for the CI work, then stopped at the owner's
handoff request before results were available. It is **not a passing full-suite
result**. Its partial log is
`$HOME/scratch/reverie/page-speed/full-web-tests.log`. No full-suite runner should
be left deliberately running from this handoff.

## CI and release work still to implement

Only `.github/workflows/image.yml` exists. It builds/checks images for PRs and
pushes to `main`; publishing is currently tied to a published GitHub release,
whose notes must match `Reviewed commit: <SHA>`. A version-tag push alone does not
currently trigger the requested release. There is no every-branch push test
workflow yet. Only existing release tag observed was `v0.1.0`.

Recommended continuation:

1. Add a reusable CI workflow and run it for every branch push and PR. Make tag
   image jobs depend on successful CI for that exact commit. Keep existing image
   boot, owner-auth, recreation/persistence, provider smoke and content-scan gates.
2. `nix/package.nix` currently runs an explicit subset of console tests (90 files).
   Expand to the canonical full `npm test` portable gate, plus all root Python and
   Node tests. Do not describe this as every browser/mobile/perf suite being run.
3. `apps/web/config/vitest.ci.config.ts` deliberately excludes browser, per-machine
   mobile screenshot baselines and timing-sensitive perf tests; these have their
   own runners. Provide their required environment for any added CI jobs, and
   keep acceptance thresholds intact. Do not weaken or silently skip failing
   checks just to get a green badge.
4. Run local checks, explicitly stage intended source/docs/workflow paths, commit,
   push to PR 33, watch all checks and fix failures. Update the PR description to
   reflect the final implementation and validation.
5. Create/push an appropriate annotated version tag after its target passes, then
   watch the tag image workflow through publication. Do not claim an image was
   published merely because the tests or image build succeeded.

## Deployment notes for the host operator

Live mounts include the persistent company home/data, workspace, explicit project
grant, scratch, control socket directory, passwd/group files and read-only host
telemetry. Preserve all of them. The current container has no Docker socket or
GPU devices. Resources are 32 GiB RAM and 2,048 PIDs, restart unless-stopped.

Existing Nix updater:
`$HOME/scratch/reverie/kokoro/updater/bin/reverie-update`.
Build the exact immutable flake source used by the updater to avoid duplicate
test/build derivations. Use a real directory path for Nix `build-dir` when scratch
is a symlink. Back up private state before restarting and compare the owner
account before/after. Do not put backup archives in the repository.

Agent-plan build/scan/deployment receipts are under
`$HOME/scratch/reverie/agent-plans/` and
`$HOME/scratch/reverie/receipts/agent-plans-deploy-20261022/`.
A private host script named
`$HOME/scratch/reverie/agent-plans/enable-and-resume.mjs` is now wake-only: it
temporarily issues a legitimate host service token, resumes only desired-running
employees and revokes the token in `finally`. Review before reuse. Service tokens
do not authorize owner-only permission changes; do not weaken that policy.

The separate host `nixos_config` checkout was dirty before this task. Do not
revert, broadly edit or activate it as part of finishing this work.
