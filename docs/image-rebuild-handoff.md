# Image rebuild checklist for review


Here, coordinator means an owner-appointed agent with explicit orchestration
permission. CTO or COO titles alone grant no approval or host authority.
Status, 2026-10-17: **write-up only; no build or cutover authorized tonight**.
The coordinator requested this review before any host action. A previous GO does not
override a later hold. Re-read the originating channel and verify the current coordinator
binding and recorded approval immediately before each delegated host operation.

The private `reports/image-build-checklist.md` in the persistent instance handoff
is the deployment inventory. This document translates its items 1–11 into gates;
it is not proof that an image already contains them. Record the reviewed inventory
revision, source hashes, test evidence and resulting image digest in the handoff.

## 1. Establish the actual source of truth

- The runtime engineer inventories the CURRENT `/opt/reverie/apps/console`, installed
  `reverie` package, `/workspace/python/reverie`, supervisor and relevant dependency versions.
  Capture the deploy log and a new relative-path/SHA256 manifest. Preserve files
  needed for source, tests, build, skills and plugins; never stage private instance
  data, agent homes, credentials or raw conversations into an image context.
- Reconcile the deployed console with canonical `apps/console` in an isolated
  worktree. Preserve both versions and obtain independent review of every delta.
  Historical drift counts are not a current measurement.
- Checklist item 11 requires a fresh carry snapshot from the CURRENT deployment.
  Record deployed batches, timestamps and superseded snapshot paths in the private
  instance handoff. Never reuse a snapshot that predates a live deployment. Any
  later deploy invalidates the new snapshot too.
- Rebuild the installed Python package from the reconciled source (items 1, 2, 4
  and 6). Verify both installed CLI imports and source-based runtime paths use the
  reviewed implementation: shared-room tone, profile runtime v4, sleep/floors and
  supervisor support. Do not reinstall an earlier runtime v3 from an old note.
- Preserve the external runtime-policy mappings using current agent IDs. Verify
  the supervisor reads the existing `child.env` and passes `REVERIE_RUNTIME_POLICY`.
  These private policy/config files stay in the persistent instance, not the image.

## 2. Include the reviewed image requirements

| Inventory items | Requirement | Acceptance before cutover |
|---|---|---|
| 1–7, 11 | Reconciled console and installed runtime, including latest batch and supervisor | Source/installed manifests match the reviewed inputs; isolated typecheck, relevant tests, build and runtime CLI checks pass |
| 8 | Playwright 1.60.0 Chromium/WebKit OS packages from `docker/playwright-system-packages.txt` | Dependency dry-run reports complete; both engines render a local fixture as the agent user; browser cache remains user-owned |
| 9 | Reviewed generic graphics libraries; selected host CDI device only at the scheduled recreate | Owner host-toolkit prerequisite complete; hardware renderer and concurrent model-response checks in the GPU plan pass |
| 10 | Single-user Nix and its tested configuration in the image | All Nix gates below pass; no host-created OMC closure/image workaround |

Use [browser-testing.md](browser-testing.md) and
[gpu-container-plan.md](gpu-container-plan.md) for their detailed checks. Existing
browser smoke evidence proves software rendering only, not GPU hardware access.
Record pinned agent CLI and Python dependency versions from the reviewed build
inputs; do not silently upgrade them during reconciliation.

### Item 10: Nix in the image

**Pending prerequisite:** the runtime engineer's tested in-container Nix how-to.
Its schedule belongs in the private instance handoff. Its revision, Nix version, installer
integrity check, exact config and acceptance logs must be supplied and accepted
before preparing the permanent Containerfile patch. Reproduce that setup rather
than inventing a second installation route.

Review and verify:

1. Single-user `/nix` owned by the configured agent user, initially UID 2000; no
   daemon and no root required for normal tool installation/builds.
2. The exact sandbox setting works in rootless Podman. Any relaxation is documented
   and reviewed, rather than concealed as a successful sandboxed build.
3. `experimental-features` enables `nix-command flakes`. Substituters and public
   signing keys are pinned: the official cache, plus a Rumoca cache only if verified
   in its CI. No tokens or host credentials enter the image.
4. A 30 GiB store budget, explicit GC-root/retention policy and build admission
   are documented. This does not authorize deleting the current OMC stopgap or
   another task's paths. Preserve active roots and report budget exhaustion.
5. Image layers provide Nix and configuration; subsequent agent-fetched/built
   tools live in the container layer and are re-fetched after recreation. No host
   store mount or recurring host closure copy is needed.
6. As the agent user, the pinned Rumoca flake resolves the exact CI OMC derivation,
   then `nix build --dry-run .#openmodelica-cli` reports fetch/build scope before
   an admitted build (at most eight cores). Verify the selected result's version
   is `a96aa1a-cmake`, its runtime resources work, and the pinned dev shell works.
   The precise CI input/derivation and one-time host-registration handoff are in
   [openmodelica-runtime.md](openmodelica-runtime.md).

Any existing copied, root-owned store paths are a transitional condition of the
live instance, not the desired image recipe. Inventory them privately and verify them against
exported host registration hashes under the engineer's reviewed procedure. Do not
re-hash them to invent trust. The copied closure, archive and superseded helper
remain preserved pending an explicit owner removal decision.

## 3. Build and prove a candidate without touching production

After review and a fresh build GO, use an isolated, manifest-identified context
under `<container-scratch-root>/build/<task>` (host `<host-scratch-root>/build/<task>`), with
reviewed console and runtime inputs. Keep durable review receipts in the repository
or external instance handoff. Build a new local tag and record its immutable image
digest; do not overwrite the rollback image or publish it.

Use a disposable fixture instance/home, no production binds and no public ports.
Run the repository Python/Node checks, console CI-config tests and relevant browser
checks with sanitized fixture environment and resource admission. Never bypass a
live-instance test guard. Verify installed CLIs, Python imports, supervisor env-file
handling, profiles and Nix as the runtime user. Tests reading source via PYTHONPATH
alone do not prove the installed package is current. Retain results and failures.

## 4. Request cutover only after candidate acceptance

The coordinator reviews the manifest, code/test receipts, immutable image digest, create
settings diff, identity/history preservation plan, rollback and quiet window.
Host toolkit activation remains an ordinary owner-authenticated operation.
Nothing here grants new container access, network exposure or host permissions.

Follow [host-recreate-handoff.md](host-recreate-handoff.md) only after that approval.
Its tracked blocker RECREATE-001 must be closed with review and test receipts
before the next recreate.
If a same-image recreate is chosen instead, it still needs a NEW current-console
manifest and all reviewed live-layer runtime/browser changes applied before
startup. It is not a reason to revive the superseded OMC unpack procedure.
