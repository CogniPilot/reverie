# Agent laptops: development handoff (2026-10-22)

The owner requested winding down and handing this work to the internal team.
The shared checkout has uncommitted implementation and tests. No commit, push,
release, host driver change or GPU grant was made by this session. Preserve the
other contributors' changes; stage explicit paths only. Read README.md, AGENTS.md
and apps/web/CLAUDE.md before continuing.

## Live deployment

- The console and work laptops are separate Docker containers built through the
  flake. The host user service `reverie-worker-broker.service` owns execution and
  the offline watchdog. Laptop programs continue through a website-only restart.
- Current deployed protection is 4 GiB RAM and 512 tasks per laptop, no swap,
  uncapped CPU with fair shares; the console is 8 GiB/512 tasks with init.
  Admission limits are active. The optional NixOS pooled slice is **not activated**;
  ordinary owner host activation is required. Do not claim pooled protection.
- Scratch/home persist separately from disposable containers. Each laptop has
  labelled scratch. Use leased task workspaces and save a handoff before cleanup.
- Laptops receive a scoped office API, explicit project/account mounts and their
  own home. They have no engine socket, broker socket or console private state.
- The host watchdog stops laptops after ten minutes without the office API.
  Explicit Stop Reverie stops laptops before the website; Stop all agents keeps
  the website open; Restart website keeps working laptops running.
- UTF-8 terminal attachment is deployed in the host broker. The original ASCII
  borders arose because Docker/tmux attach clients negotiated a non-UTF-8 locale.
  `tmux -u` plus explicit UTF-8 locale fixes new connections without restarting
  the provider program. Older detached viewer processes can remain: see pending
  viewer cleanup below.
- An existing host local-model service and GUI endpoint profile were verified.
  No expert's selected runtime/model was changed. Existing Runtime settings can
  select the configured local endpoint with OpenCode; Codex config-directory
  injection is refused by the in-place runtime-switch route. The new Company
  local-model card is **not deployed**.

Respect the latest owner-controlled desired-running/on-vacation state. Other
experts were enabled through the GUI during this work; an earlier two-expert
restriction is no longer a valid snapshot. Do not blanket-wake or pause people.

## Completed source, pending deployment/review

1. `apps/web/src/web/public/chat-app.js`: persistent In office switch using the
   existing durable vacation/desired-running API. Off remains off through recovery.
   Retirement stays in the Company card under collapsed Remove from company.
   Sleep/Dream now autosave their two fields on change, with per-card success/error
   feedback and checkbox rollback on failure. Previously those boxes only saved
   through Save preferences, so an unsaved check disappeared on reload/restart.
2. `company-plans.html` and `company-board.css`: distinct local-model endpoint cards
   in the same plan grid, with model, allocated people and fresh host-published GPU
   utilization/shared memory. They have no subscription burn chart/reset controls.
   They read existing owner-authorized APIs, never inject endpoint credentials into
   markup, and retain subscription cards if a local API fails.
3. `python/reverie/worker.py`: an additional **source-only** `attach-session -d`
   replaces stale terminal viewers on reconnect without replacing the pane or
   provider process. Its real-container regression asserts exactly one UTF-8 viewer
   after reattachment. The deployed broker has UTF-8 but not this last viewer fix.
4. Optional GPU/browser support is source-only. See `docs/worker-gpu.md`:
   UUID-only per-session CDI grants, separate `browserRuntime` and
   `workerBrowserImage`, bounded diagnostic probe. Default worker image gets no
   browser/GPU grant. Existing host model service was not interrupted.

Core isolation source is in `python/reverie/worker.py`, `apps/host/isolate.py`,
`nix/worker-isolation.nix`, the flake/image/package changes, `worker-execution.ts`,
`session.ts`, `tmux-manager.ts` and `laptop-power-routes.ts`. Installer discovery
and process-init fixes are also in the working tree; do not duplicate or drop them.
The preexisting local-model shell-export adjustment in flake.nix and
`docs/runtime-ci-performance-handoff.md` were present before this work.

## Evidence and acceptance

- Original shared console reached its 2048-task cap with approximately 1909
  zombies under Node PID 1, kernel EAGAIN/thread-creation failures and no OOM.
  Init/reaping and isolated kernel limits address that demonstrated failure.
  This does not establish which individual task caused every stalled installer.
- Full Python suite: delegated GPU validation passed 660 tests; final targeted
  worker/GPU/image-scanner tests passed 33. Required OpenCode Node tests passed.
- First new-UI Nix console build: 1323/1324 tests passed (92 files). One extracted
  function test fixture lacked the newly introduced `localPlans` global. The
  fixture was updated without removing its empty-account assertion; targeted
  rerun passed. The second Nix console build passed all 1324 tests across 92 files;
  its Python package passed 661 tests with one skip. Nix image packaging completed
  successfully. The artifact is GC-rooted by the host-side
  `$HOME/reverie/runtime/worker-isolation/office-ui-image` link; its JSON receipt is
  `office-ui-build.json` in the private incident directory below. This new image
  was **not scanned, loaded or deployed** during wind-down. The final source-only
  viewer cleanup was tested separately after that image build's source snapshot.
- Focused UI tests passed 67 cases before the fixture correction; real Playwright
  `.github/ci/company-office-browser.mjs` passes multi-expert Sleep/Dream reload
  persistence, off-state intent, hidden retirement, local/paid cards in one grid,
  GPU values, allocated people and mobile overflow checks. Screenshots inspected.
- `.github/ci/worker-isolation-smoke.py` passed real Docker terminal I/O/resize,
  UTF-8, orphan reaping, private mounts, task exhaustion and memory OOM while a
  second laptop/server stayed responsive, website-disconnect work continuity,
  same-program reconnect, accelerated watchdog and explicit stop-all. The latest
  rerun also passed the single-viewer reconnect assertion.
- GPU: Nix Chromium runtime built. Native sandboxed **NVIDIA WebGL pixel readback
  passed**. WebGPU returned no adapter, so full GPU acceptance correctly fails.
  Container graphics/sandbox acceptance and model-inference coexistence remain
  unverified. Do not enable or advertise them as working yet.

Host-only private receipts/logs are under `$HOME/scratch/reverie/incidents/2026-10-22-pids`.
GPU receipts are under `$HOME/scratch/reverie/tasks/gpu-browser-validation-20261022`.
These paths are not automatically exposed in every laptop. Do not copy private
state backups, identity, credentials or runtime metadata into this repository.

## Next steps

1. Coordinate with the team's existing release/review schedule in #reverie before
   modifying or deploying the shared work. The owner requested no further live
   deployment during this handoff. Record any proposed new memory/task defaults
   separately from the actual deployed 4 GiB/512 baseline and validate admission.
   The laptop launch/broker/image implementation belongs to this Reverie repo;
   host service pins, engine access and owner-selected private policy live outside
   the repo. Do not build a competing supervisor because host policy is external.
   The ten-minute offline shutdown was an explicit owner requirement to avoid
   unintentional plan use during prolonged outages; it is intentional behavior,
   not a defect to remove while adding session supervision.
2. Review the UI/source changes and exact image-build result. Required gates remain:
   `nix develop --command python3 -m unittest discover -s tests` and
   `nix develop --command node --test tests/test_opencode_plugin.mjs`, relevant
   console tests, the actual UI browser checks and real-container smoke. Run the
   browser fixture with container-visible Playwright/browser paths as needed.
3. Finish image preparation/scan and coordinated website-only deployment through
   the owner-controlled host workflow. Host pins/plans live outside this repo in
   `$HOME/reverie/runtime/worker-isolation`. Retain rollback images/containers and
   state backups. Do not stop/recreate working laptops just to deploy UI assets.
4. Website startup currently restores the selected recovery expert first; other
   persistent laptops may require authenticated per-expert wake requests to
   re-register their terminal views. These reattach an existing laptop/program.
   Parse `recovery.skipped` as an array of `{employeeId, reason}`; HTTP success
   alone does not mean attachment succeeded. Respect `recovery-in-progress` and
   intentionally-ended/off-state decisions. Automatic fleet reattachment needs
   dedicated follow-up, not a claim that synthetic continuity proves the full UI.
5. Deploy the last terminal-viewer cleanup only after its checks. Host broker
   changes require a matching Nix service pin; direct-file `worker.py` execution
   now needs its sibling `worker_gpu.py`. Stop/restart only the website connection
   around broker maintenance and verify provider PIDs/container start times.
6. Keep root exports/caches on scratch. The checkout node_modules link used for
   host tests points into a host-only leased cache, so it does not resolve inside
   laptops. This is known pending work: provide container-visible dependencies and
   a writable Vite cache rather than treating that link as a portable solution.
7. GPU owner/reviewer can continue the explicit container/WebGPU/coexistence
   acceptance in `docs/worker-gpu.md`. Do not bypass sandbox or host admin boundaries.

The CLI currently lives inside its work laptop. Website restarts preserve it;
restarting that laptop cannot preserve the same CLI process. A separately
supervised model/backend with proxied tool execution is a larger future boundary
change, and must be distinguished from the website/laptop split already deployed.
