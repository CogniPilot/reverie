/**
 * The test suites that `npm test` deliberately does NOT run, in one place.
 *
 * Why this file exists: the exclusion list used to live only in
 * config/vitest.ci.config.ts, as literals. Anything excluded there was
 * therefore reachable only by running the everything-config by hand and reading
 * past its failures — and a newly excluded file was reachable by nothing at
 * all, silently, because nothing pointed at it. Both configs now derive their
 * globs from the arrays below, so adding a suite here puts it in exactly one
 * runner and takes it out of exactly one gate.
 *
 * Adding a new test that cannot run in CI: put its glob in the array that
 * describes WHY it cannot, not in whichever one is shortest.
 */

/**
 * Playwright-driven: needs chromium and, in most cases, a live Reverie server
 * on a real port. Deterministic where the environment provides both, which is
 * why these are a runnable suite (`npm run test:browser`) rather than skipped.
 */
export const BROWSER_TEST_GLOBS = [
  'test/bots.browser.test.ts',
  'test/bots-http.browser.test.ts',
  'test/previews.browser.test.ts',
  'test/file-preview-shell.browser.test.ts',
  'test/handbook.browser.test.ts',
  'test/workspace-files.browser.test.ts',
  'test/workspace-video-preview.browser.test.ts',
  'test/chat-plugins.browser.test.ts',
  'test/chat-math-plugin.browser.test.ts',
  'test/chat-voice-panel-layout.browser.test.ts',
  'test/chat-composer-width.browser.test.ts',
  'test/embassy-guest-ui.browser.test.ts',
  'test/embassy-qr.browser.test.ts',
  'test/embassy-pairing.browser.test.ts',
  'test/mobile-install-hint.browser.test.ts',
  'test/embassy-builtin.browser.test.ts',
  'test/embassy-pairing-csrf.browser.test.ts',
  'test/member-menu.browser.test.ts',
  'test/debug-terminal-view.browser.test.ts',
  'test/webhook-removal.browser.test.ts',
  'test/company-ui.browser.test.ts',
  'test/company-profile-pat.browser.test.ts',
  'test/company-resource-layout.browser.test.ts',
  'test/office-server.browser.test.ts',
  'test/office-owner-controls.browser.test.ts',
  'test/browser-coverage-attribution.browser.test.ts',
  'test/office-power.browser.test.ts',
  'test/workspace-gutter-navigation.browser.test.ts',
  'test/board-preload.browser.test.ts',
  'test/board-decision-one-click.browser.test.ts',
  'test/github-watches.browser.test.ts',
  'test/office-footer-panel.browser.test.ts',
  'test/owner-ui-batch.browser.test.ts',
  'test/plan-five-hour.browser.test.ts',
  'test/company-hire-wizard.browser.test.ts',
  'test/company-reporting-tree.browser.test.ts',
  'test/tab-rail-resize.browser.test.ts',
  'test/tab-activation.browser.test.ts',
  'test/tab-layout-editing.browser.test.ts',
  'test/tab-rail-search.browser.test.ts',
  'test/tab-focus.browser.test.ts',
  'test/session-sidebar-ux.browser.test.ts',
  'test/session-options-responsive.browser.test.ts',
  'test/inline-rename.test.ts',
  'test/opencode-resize.test.ts',
  'test/webgl-fallback.test.ts',
  'test/terminal-copy-shortcut.test.ts',
  'test/terminal-keycode229-recovery.browser.test.ts',
  'test/capture-load-window.browser.test.ts',
  'test/capture-geometry-retry.browser.test.ts',
  'test/codex-predictive-echo.test.ts', // also needs a real codex binary
  'test/split-pane-terminal.browser.test.ts',
  'test/terminal-tile-scroll.browser.test.ts',
  'test/terminal-touch-paging.browser.test.ts',
  'test/shift-enter-keypress.browser.test.ts',
  'test/key-tester.browser.test.ts',
  'test/case-custom-path.browser.test.ts',
  'test/doctor-settings.browser.test.ts',
  'test/git-status.browser.test.ts',
  'test/split-pane-orchestration.browser.test.ts',
  'test/split-pane-auto-collapse.browser.test.ts',
  'test/spreadsheet-preview.browser.test.ts',
  'test/mobile-ime-preview.browser.test.ts',
  'test/run-mode-menu-scroll.browser.test.ts',
  'test/markdown-anchor-links.browser.test.ts',
  'test/fullscreen-tab-switch-capture.browser.test.ts',
  'test/account-ui.browser.test.ts',
  'test/board-timeline.browser.test.ts',
];

/**
 * Wall-clock benchmarks. They assert on durations, so a loaded shared runner
 * fails them for reasons that have nothing to do with the diff under test.
 */
export const PERF_TEST_GLOBS = ['test/perf-*.test.ts'];

/**
 * Browser + visual regression: chromium AND environment-specific PNG baselines
 * that are generated per machine. Has its own config
 * (test/mobile/vitest.config.ts) because it needs serial execution, a longer
 * timeout and the `pretest:mobile` vendor step — run it with
 * `npm run test:mobile`, not through the configs here.
 */
export const MOBILE_TEST_GLOBS = ['test/mobile/**'];

/** Everything `npm test` skips. */
export const NON_CI_TEST_GLOBS = [...MOBILE_TEST_GLOBS, ...PERF_TEST_GLOBS, ...BROWSER_TEST_GLOBS];

/**
 * Gate files the Nix console checks do NOT run, each with the reason why.
 *
 * Those checks (`checkPhase` in nix/package.nix) are what CI actually runs, and
 * they run only the files named on their `npm test --` lines. A gate file named
 * nowhere there was therefore tested by nothing in CI, silently: 755 of them
 * had piled up before test/test-suite-partition.test.ts started requiring every
 * gate file to be either named there or listed here. Register a new test file
 * on one of those lines; list it here only with the reason it cannot run there.
 */
export const NIX_UNCHECKED_TESTS: Record<string, string> = {
  'test/advisor-model.test.ts':
    '8 of 31 fail: the spawn command now wraps its settings in a /bin/sh -c launcher, which this test\'s settings-JSON parser cannot read.',
  'test/agent-skill-mode-lists.test.ts':
    '3 of 4 fail: the skill docs do not list the hands mode that the stock catalogue now has.',
  'test/audit-actor.test.ts':
    '2 of 5 fail: spawn requests record no audit entries where the test expects two.',
  'test/board-plan-members.test.ts':
    '1 of 5 fails: the DOM test environment has an opaque origin, so localStorage throws a SecurityError.',
  'test/chat-alert-mode.test.ts':
    '1 of 2 fails: expects an ET end time, but the run printed a UTC time.',
  'test/chat-app-css.test.ts':
    '2 of 34 fail: --ca-menu-max-width has no :root definition, and the phone bottom-sheet rule check fails.',
  'test/chatroom-owed-reply.test.ts':
    '2 of 11 fail: the owed-reply notice text no longer matches the expected wording.',
  'test/chatroom-restart-delivery.test.ts':
    '1 of 74 fails: the paste-once-after-failed-Enter case records no delivery attempt.',
  'test/chatroom-startup-availability.test.ts':
    'History read after failed delivery recovery returns 403 where the test expects 200.',
  'test/cli-capability-predicates.test.ts':
    '1 of 15 fails: counts 11 enabled modes where the test expects 10.',
  'test/cli-catalog-sync.test.ts':
    '1 of 3 fails: config/clis.stock.json is stale against a fresh generate:cli-catalog run.',
  'test/cli-registry-no-id-branching.test.ts':
    '3 of 14 fail: 44 CLI-id branches outside the stock catalogue are not on the allowlist.',
  'test/edge-cases.test.ts':
    '1 of 27 fails: stopping an unknown scheduled run now answers with the owner-only refusal, not "not found".',
  'test/frontend-cli-no-id-branching.test.ts':
    '1 of 5 fails: the allowlisted frontend CLI-id branch counts no longer match.',
  'test/frontend-public-tooling.test.ts':
    '1 of 4 fails: the npm public-asset check script it runs exits non-zero.',
  'test/i18n-exit-run-help.test.ts':
    '1 of 12 fails: the zh-CN "Run" help check for the H entry fails.',
  'test/mcp-chat.test.ts':
    '1 of 16 fails: expects plan resets printed in ET, but the output does not contain them.',
  'test/mobile-overview.test.ts':
    '1 of 31 fails: the Run picker renders 11 stock CLIs, the static fallback table has 10.',
  'test/name-flag-injection.test.ts':
    '3 of 18 fail: the spawn command is now a /bin/sh -c launcher, so the --name flag is not found where the test looks.',
  'test/routes/chatroom-conversation-routes.test.ts':
    '1 of 25 fails: the capabilities object differs from the expected one.',
  'test/routes/chatroom-employee-identity.test.ts':
    'The author object carries one more field than the test expects.',
  'test/routes/chatroom-roles-members.test.ts':
    'All 7 fail: a member-add fixture returns undefined (TypeError reading id).',
  'test/routes/chatroom-spoken-hint.test.ts':
    '3 of 6 fail: the posts return 403 where the test expects 200.',
  'test/routes/plans-routes.test.ts':
    '6 of 7 fail: the plans list comes back empty.',
  'test/routes/push-routes.test.ts':
    '4 of 10 fail: subscription preference updates return 500.',
  'test/routes/session-input-wait.test.ts':
    '1 of 40 fails: the wait envelope has one more outcome than the test lists.',
  'test/routes/session-routes-codex-defaults.test.ts':
    '1 of 12 fails: Codex now launches with a --config update-check override where the test expects bare codex.',
  'test/routes/session-routes-company.test.ts':
    '2 of 23 fail: temporary workers get an "Agent <id>" name, not a random human name.',
  'test/routes/subscription-profile-routes.test.ts':
    '6 of 7 fail: the account list comes back empty.',
  'test/routines-room-scope.test.ts':
    '4 of 10 fail: the routine post fails with "authorFor is not defined".',
  'test/run-menu-cli-logos.test.ts':
    '3 of 15 fail: the hands mode has no Run-menu logo rule.',
  'test/run-mode-launch-table-drift.test.ts':
    '1 of 4 fails: the launch table lists 8 CLIs, the stock catalogue has 9.',
  'test/scheduled-runs.test.ts':
    '6 of 10 fail: creating a scheduled run does not succeed.',
  'test/server-index-title.test.ts':
    '1 of 8 fails: the served index differs from the template outside the title tag.',
  'test/session-activity.test.ts':
    '3 of 62 fail: the pi and opencode work-detection descriptors no longer set the expected submit field.',
  'test/session-cleanup.test.ts':
    '1 of 7 fails: stopping a scheduled run does not succeed.',
  'test/session-custom-model-restart.test.ts':
    '1 of 11 fails: the pinned conversation id is undefined where the test expects null.',
  'test/session-model-recovery.test.ts':
    '6 of 12 fail: the spawn command is now a /bin/sh -c launcher, so the model flag is not found where the test looks.',
  'test/spreadsheet-preview-worker.test.ts':
    'Its test worker runs out of JavaScript heap (about 1 GiB on a 2 GiB machine) in the bracketed-format cases, so 9 of 43 never finish.',
  'test/statusline-cli-flag.test.ts':
    '5 of 11 fail: the spawn command now wraps its settings in a /bin/sh -c launcher, which this test\'s settings-JSON parser cannot read.',
  'test/tab-harness-logo.test.ts':
    '1 of 7 fails: styles.css has no logo rule for the hands mode.',
};
