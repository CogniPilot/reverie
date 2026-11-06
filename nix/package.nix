{ pkgs, src }:
let
  lib = pkgs.lib;
  manifest = builtins.fromJSON (builtins.readFile (src + "/apps/web/package.json"));
  consoleSkill = lib.cleanSource (src + "/skills/reverie");
  goalPythonFixture = lib.cleanSource (src + "/python/reverie");
  # Copy individual fixture files into the store. Interpolating ${src}/path
  # otherwise makes every repository edit an input to the console derivation.
  # Use the original snapshot for the selected files so read-only flake check
  # evaluation never has to materialize the intermediate filtered root first.
  consoleFixture = relative: builtins.path { path = (src.origSrc or src) + "/${relative}"; };
  rustRouteHandler = import ./rust-route-handler.nix { inherit pkgs src; };
  console = pkgs.buildNpmPackage {
    pname = "reverie-console";
    version = manifest.version;
    src = lib.cleanSource (src + "/apps/web");
    nodejs = pkgs.nodejs_22;
    npmDepsHash = "sha256-DGKWvITtXvL3pYAsu4vqiynelRLeTR8BkjXJmLqMNc0=";
    nativeBuildInputs = [ pkgs.python3 pkgs.makeWrapper ];
    npmFlags = [ "--ignore-scripts" ];
    npmRebuildFlags = [ "--ignore-scripts" ];
    CI = "1";
    REVERIE_NO_AUTOSTART = "1";
    PUPPETEER_SKIP_DOWNLOAD = "1";
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
    postPatch = ''
      mkdir -p skills
      cp -r ${consoleSkill} skills/reverie
      mkdir -p test/fixtures/recovery-ledger/reverie
      cp ${consoleFixture "python/reverie/__init__.py"} test/fixtures/recovery-ledger/reverie/__init__.py
      cp ${consoleFixture "python/reverie/resume_ledger.py"} test/fixtures/recovery-ledger/reverie/resume_ledger.py
      cp ${consoleFixture "python/reverie/resume_ledger_rpc.py"} test/fixtures/recovery-ledger/reverie/resume_ledger_rpc.py
      # The web derivation is flattened to apps/web. Supply explicit trusted
      # offline test sources; tests must not escape /build/source to find them.
      mkdir -p test/fixtures/goal-source/python test/fixtures/goal-source/tests
      cp -r ${goalPythonFixture} test/fixtures/goal-source/python/reverie
      cp ${consoleFixture "tests/__init__.py"} test/fixtures/goal-source/tests/__init__.py
      cp ${consoleFixture "tests/goal_private_fixture.py"} test/fixtures/goal-source/tests/goal_private_fixture.py
      cp ${consoleFixture "tests/goal_broker_fixture.py"} test/fixtures/goal-source/tests/goal_broker_fixture.py
      # The Rust handler's TS byte goldens live with its crate.
      mkdir -p test/fixtures/subscription-profiles
      cp ${consoleFixture "crates/reverie-routes/tests/fixtures/subscription-profiles/cases.json"} test/fixtures/subscription-profiles/cases.json
      cp ${consoleFixture "crates/reverie-routes/tests/fixtures/subscription-profiles/goldens.json"} test/fixtures/subscription-profiles/goldens.json
      # The route frame cases are shared with the Rust codec in reverie-contracts.
      mkdir -p test/fixtures/route-frames-v1
      cp ${consoleFixture "crates/reverie-contracts/tests/fixtures/route-frames-v1/cases.json"} test/fixtures/route-frames-v1/cases.json
      # test/test-suite-partition.test.ts reads the npm test commands below from this copy.
      mkdir -p test/fixtures/nix-package
      cp ${consoleFixture "nix/package.nix"} test/fixtures/nix-package/package.nix
    '';
    preBuild = "npm rebuild node-pty esbuild --offline --ignore-scripts=false";
    doCheck = true;
    nativeCheckInputs = [ pkgs.git pkgs.tmux pkgs.curl pkgs.which pkgs.procps (lib.getBin pkgs.util-linux) ];
    checkPhase = ''
      runHook preCheck
      npm test -- test/fixed-resume-message.test.ts test/recovery-authority.test.ts \
        test/recovery-transaction.test.ts test/recovery-operation-clock.test.ts test/recovery-ledger-client.test.ts \
        test/rest-canonical-metadata.test.ts \
        test/company-recover.test.ts test/routes/company-routes.test.ts \
        test/cli-agent-chat-fetch.test.ts test/cli-agent-chat-stdin.test.ts test/cli-agent-chat-file.test.ts \
        test/chat-bot-presets.test.ts test/cron-post-bot.test.ts test/cron-post-security.test.ts \
        test/chatroom-delivery-modes.test.ts test/routes/polling-membership.test.ts \
        test/company-service.test.ts test/company-office-enforced-auth.test.ts test/company-hierarchy.test.ts \
        test/owner-auth-admin-grant.test.ts test/owner-auth-review.test.ts \
        test/experts-api.test.ts test/experts-delegated-server.test.ts test/delegated-session-create.test.ts test/self-update.test.ts \
        test/owner-auth-lock-portability.test.ts test/company-full-page.test.ts \
        test/service-installer.test.ts test/company-wake.test.ts test/host-worker-resume.test.ts test/host-worker-resume-reconnect.test.ts \
        test/company-recovery-prompt.test.ts test/company-wake-server.test.ts \
        test/goal-lifecycle.test.ts test/goal-lifecycle-transactions.test.ts test/goal-api-auth.test.ts \
        test/goal-response-privacy.test.ts test/goal-successor-independent.test.ts \
        test/goal-server-integration.test.ts test/goal-server-unavailable.test.ts test/goal-server-policy.test.ts \
        test/goal-canonical-authority.test.ts test/goal-manager-verification.test.ts \
        test/goal-broker-auth.test.ts test/goal-nonce-store.test.ts test/goal-nonce-independent.test.ts test/goal-nonce-successor.test.ts \
        test/cli-goal.test.ts test/goal-canonical-transport.test.ts test/goal-combined-server.test.ts test/goal-server-assembly.test.ts \
        test/goal-private-launch.test.ts test/goal-owner-only-launch.test.ts test/goal-human-policy-integration.test.ts test/goal-custody-channel.test.ts test/goal-bootstrap-order.test.ts test/goal-source-fixture.test.ts \
        test/owner-auth-fresh-enforce.test.ts test/routines-owner-middleware.test.ts \
        test/routes/status-page-auth.test.ts test/routes/status-page-routes.test.ts test/routes/html-view-routes.test.ts \
        test/routine-announcement-room.test.ts test/routine-announcement-server.test.ts \
        test/owner-auth-board-decisions.test.ts test/board-decision-options.test.ts test/board-decision-fallback-current.test.ts test/cli-board.test.ts test/routes/board-routes.test.ts \
        test/board-decision-config.test.ts test/routes/system-routes-settings-partial-put.test.ts \
        test/office-power-ui.test.ts test/company-lifecycle-fence.test.ts test/github-source.test.ts test/owner-first-setup.test.ts \
        test/fixed-github-watch.test.ts test/fixed-watch-delivery.test.ts test/fixed-watch-server.test.ts \
        test/routine-backup-recovery.test.ts test/routine-recovery-controls.test.ts \
        test/cron-recovery-inflight.test.ts \
        test/owner-auth.test.ts test/owner-route-principals.test.ts test/routines-grants-owner.test.ts test/owner-setup-ui.test.ts \
        test/owner-name-onboarding.test.ts \
        test/account-login.test.ts test/chat-workspace-delete.test.ts \
        test/routes/company-hire-routes.test.ts test/company-native-ui.test.ts \
        test/local-model-profile.test.ts test/routes/quick-start-custom-model.test.ts \
        test/plan-auth-status.test.ts test/plan-account-management.test.ts \
        test/subscription-profile-remove.test.ts test/subscription-profiles.test.ts \
        test/cli-registry-spawn-golden.test.ts test/claude-launch-selection.test.ts test/claude-launch-attribution.test.ts test/company-lifecycle-ui.test.ts test/company-voice-ui.test.ts \
        test/employee-pronouns.test.ts test/routes/voice-speak-routes.test.ts \
        test/hands-free.test.ts test/car-hands-free.test.ts test/voice-chat.test.ts test/car-mode.test.ts \
        test/car-mode-team-voice.test.ts test/car-mode-member-voice.test.ts test/car-reply-voice.test.ts test/car-turn-link.test.ts \
        test/routes/voice-turn-routes.test.ts test/routes/voice-service-status.test.ts test/voice-member-dispatch.test.ts test/chat-app-dm-voice.test.ts \
        test/read-aloud-team-voice.test.ts test/session-cli-builder.test.ts test/board-page-routes.test.ts test/company-logos.test.ts \
        test/reboot-restore.test.ts test/reboot-restore-persistent.test.ts \
        test/routes/reboot-restore-routes.test.ts test/codex-transcript.test.ts test/routes/company-avatar.test.ts \
        test/company-avatar-picker-ui.test.ts test/agent-avatar-background.test.ts test/company-hire-plan-refresh.test.ts \
        test/company-hire-wizard.test.ts test/company-role-context.test.ts test/company-rest-context.test.ts test/handbook.test.ts test/company-preferences-autosave.test.ts \
        test/employee-gpu-access.test.ts test/employee-gpu-ui.test.ts test/company-settings-ui.test.ts test/chat-app-dom.test.ts test/chat-reference-navigation.test.ts test/profile-avatar-preview.test.ts test/cli-config-content.test.ts \
        test/session-health-provider.test.ts test/session-health-provider-routes.test.ts test/health-canonical-reader.test.ts \
        test/session-runtime.test.ts test/owner-dead-pane-recovery.test.ts test/company-runtime-health-ui.test.ts test/company-runtime-ui.test.ts test/opencode-subscription-auth.test.ts \
        test/selected-claude-profile.test.ts \
        test/routes/chat-turn-summary.test.ts test/cli-chat-summary.test.ts \
        test/chatroom-digest.test.ts test/chatroom-notice-state.test.ts test/chatroom-notice-history.test.ts test/chatroom-notice-cli.test.ts test/chat-db.test.ts test/chat-message-search.test.ts \
        test/managed-codex-trust.test.ts test/codex-hook-trust.test.ts test/full-access-default.test.ts test/worker-execution.test.ts test/laptop-power.test.ts test/laptop-reconnect.test.ts test/worker-viewer-reconnect.test.ts test/worker-recovery-auth.test.ts test/native-worker-viewer-acceptance.test.ts test/worker-provider-health.test.ts \
        test/command-failure-routes.test.ts test/command-failure-ui.test.ts \
        test/expert-runtime-recipe.test.ts test/company-employee-restart.test.ts test/company-restart-ui.test.ts test/routes/session-mode-switch.test.ts \
        test/claude-plan-usage.test.ts test/claude-usage-display.test.ts test/subscription-usage.test.ts test/plan-usage-compliance.test.ts test/plan-pace.test.ts \
        test/plan-agent-burn.test.ts test/plan-agent-burn-wiring.test.ts test/plan-burn-cache-isolation.test.ts test/plan-agent-burn-ui.test.ts test/plan-move-impact-policy.test.ts \
        test/member-menu.test.ts test/menu-viewport.test.ts test/render-index-html.test.ts test/asset-content-version.test.ts \
        test/company-plans-navigation.test.ts test/company-plans-width.test.ts test/plan-five-hour-ui.test.ts \
        test/plan-move-runtime.test.ts test/plan-move-composer.test.ts test/plan-move-routes.test.ts test/plan-move-company.test.ts test/plan-move-launch.test.ts \
        test/plan-move-resources.test.ts test/plan-move-resource-runtime.test.ts \
        test/resource-owner-authority.test.ts test/resource-native-client.test.ts \
        test/company-resource-binding-cas.test.ts test/resource-session-publication.test.ts \
        test/resource-replacement-controller.test.ts test/company-laptop-memory-ui.test.ts \
        test/agent-plan-server.test.ts test/agent-plan-request.test.ts test/agent-plan-recovery.test.ts test/agent-plan-journal-recovery.test.ts test/cli-agent-force.test.ts test/cli-agent-viewer.test.ts test/plan-request.test.ts test/plan-request-capability.test.ts test/plan-request-routes.test.ts test/plan-credential-boundary.test.ts test/plan-request-ui.test.ts test/plan-request-prompt.test.ts \
        test/embassy-builtin.test.ts test/embassy-protocol-server.test.ts test/embassy-pairing-ui.test.ts \
        test/disk-stats.test.ts test/disk-stats-ui.test.ts test/routes/system-routes.test.ts test/shared-attachments.test.ts test/routes/file-routes.test.ts \
        test/chat-language-service.test.ts test/chat-plugins.test.ts test/chat-math-plugin.test.ts test/chat-code-highlighting.test.ts test/workspace-files.test.ts test/workspace-files-safety.test.ts test/workspace-publisher.test.ts \
        test/office-accounts.test.ts test/human-presence-ui.test.ts test/human-mentions-ui.test.ts test/bots-page.test.ts test/bots-ui.test.ts test/bots-disk-alarm-ui.test.ts test/bot-avatar.test.ts test/cron-service.test.ts test/office-navigation-ui.test.ts test/workspace-files-ui.test.ts test/preview-routes.test.ts
      npm test -- test/agent-capabilities.test.ts test/chat-plugin-settings.test.ts test/resource-history.test.ts
      npm test -- test/packet-check.test.ts test/cli-agent-publish.test.ts
      npm test -- test/browser-job-evidence.test.ts
      npm test -- test/cli-plans-banked-resets.test.ts
      npm test -- test/routes/chatroom-clear-history.test.ts test/chat-dm-clear-history-ui.test.ts
      npm test -- test/plan-request-pending-employee.test.ts test/cli-plan-move-list-employee.test.ts
      npm test -- test/file-preview-source-reader.test.ts test/file-preview-sources-ui.test.ts \
        test/file-preview-worker-policy.test.ts test/workspace-preview-source.test.ts \
        test/pdf-preview-terminal-state.test.ts test/pdf-preview-worker-cancellation.test.ts
      npm test -- test/cli-help.test.ts test/cli-commands.test.ts test/chat-ui-controls.test.ts \
        test/member-sorting.test.ts test/company-profile-layout.test.ts test/company-space-ui.test.ts \
        test/github-watches-ui.test.ts test/office-footer-panel.test.ts
      npm test -- test/chat-reply-releases-hold.test.ts
      npm test -- test/routes/subscription-profiles-rust-goldens.test.ts
      npm test -- test/rust-routes/frames.test.ts test/rust-routes/channel.test.ts test/rust-routes/config.test.ts \
        test/routes/subscription-profiles-forwarder.test.ts
      npm test -- test/board-permissions.test.ts \
        test/publication-credentials.test.ts test/publication-routes.test.ts test/credential-status.test.ts \
        test/employee-context.test.ts test/employee-context-routes.test.ts test/cli-agent-context.test.ts \
        test/company-board-permissions-ui.test.ts test/company-publication-ui.test.ts \
        test/company-reporting-ui.test.ts test/company-core-context-ui.test.ts
      npm test -- test/board-track.test.ts test/routes/board-track-routes.test.ts test/cli-board-track.test.ts
      NIX_REVERIE_TEST_ROOT_CUSTODY=1 npm test -- test/cli-agent-credentials.test.ts
      npm test -- test/routes/chat-attention.test.ts test/url-session-fragment.test.ts
      npm test -- test/chatroom-mentions.test.ts test/routes/chat-mentions.test.ts test/cli-agent-chat-mentions.test.ts \
        test/routes/chat-stale-notices.test.ts test/cli-agent-chat-stale.test.ts
      npm test -- test/assignment-status-watch.test.ts test/assignment-exact-read.test.ts test/display-time.test.ts test/assignment-refused-reservation.test.ts test/public-issue-watch.test.ts \
        test/bot-watches-runtime.test.ts test/bot-watch-durable-chat.test.ts test/bot-watch-state.test.ts test/disk-space-watch.test.ts \
        test/github-repository-watch-source.test.ts test/github-repository-watches.test.ts \
        test/github-repository-watch-routes.test.ts test/chat-bot-commit-authority.test.ts
      # The console owns this Python/Node composition check after its TS build.
      npm test -- test/owner-terminal-routes.test.ts test/owner-terminal-ui.test.ts
      npm test -- test/employee-journal-outcomes.test.ts test/employee-journal-outcome-boundaries.test.ts \
        test/employee-journal-map-state-scope.test.ts
      npm test -- test/submit-settle.test.ts test/session-submit-verifier.test.ts \
        test/chatroom-delivery-receipts.test.ts test/codex-chat-submit-ownership.test.ts test/codex-echoed-prompt-row.test.ts \
        test/codex-echoed-prompt-style-witnesses.test.ts \
        test/chatroom-delivery-held-seat.test.ts \
        test/chatroom-delivery-wait-reason.test.ts
      # Keep the input ownership and newly supported reply/media regressions in artifact checks.
      npm test -- test/capacity-stall.test.ts test/capacity-hold-control.test.ts test/late-verifier-hold-control.test.ts \
        test/pending-writer-control.test.ts test/verifier-gate-cleared.test.ts test/wake-claude-invariant-control.test.ts \
        test/wake-idle-boundary.test.ts test/wake-idle-invariant-control.test.ts test/wake-idle-race-witness.test.ts \
        test/write-gate-property.test.ts test/write-gate-unsent.test.ts test/tmux-manager.test.ts \
        test/late-hold-control.test.ts test/opencode-late-hold-control.test.ts test/opencode-paste-hold-control.test.ts \
        test/codex-paste-hold.test.ts test/plan-move-input-hold.test.ts test/opencode-shell-mode.test.ts \
        test/remote-buffer-move-hold-control.test.ts test/opencode-verifier-hold-control.test.ts test/remote-wake.test.ts \
        test/cli-agent.test.ts test/cli-agent-wake-employee.test.ts test/routes/session-input-delivery.test.ts \
        test/input-send-order.test.ts test/reliable-input-dedup.test.ts test/input-size-limit.test.ts test/chatroom-archived-reply.test.ts \
        test/chatroom-inline-video.test.ts test/file-preview-session-svg.test.ts
      npm test -- test/case-removal.test.ts test/routes/case-delete-guard.test.ts
      # Every other gate file; test/test-suite-partition.test.ts fails on a gate file that is in neither
      # an npm test line here nor NIX_UNCHECKED_TESTS (config/test-suites.ts).
      npm test -- test/admin-routes.test.ts test/admin-ui.test.ts test/agent-case-marker.test.ts test/agent-memory-brief-route-class.test.ts \
        test/agent-memory-brief.test.ts test/agent-skill-endpoints-doc.test.ts test/agent-skill-source.test.ts \
        test/agent-skill-targets.test.ts test/agent-skill.test.ts test/ai-idle-checker.test.ts test/antigravity-cli-resolver.test.ts \
        test/antigravity-mode.test.ts test/api-generate-plan.test.ts test/api-responses.test.ts test/app-settings-structure.test.ts \
        test/approval-inbox.test.ts test/attachment-magic.test.ts test/auth-security.test.ts test/avatar-pack-manifest.test.ts \
        test/avatar-pack-profile-select.test.ts test/away-digest-ui.test.ts test/away-digest.test.ts test/base-path-server.test.ts \
        test/base-path.test.ts test/bash-tool-parser.test.ts test/board-blocker-severity.test.ts test/board-owner-identity.test.ts \
        test/bot-avatar-history.test.ts test/bots-schedule-ui.test.ts test/bounded-path-probe.test.ts test/browser-hard-reload.test.ts \
        test/buffer-accumulator.test.ts test/buffer-management.test.ts test/car-playback-notice.test.ts test/car-speaker.test.ts \
        test/car-voice-turn-wait.test.ts test/car-wake-lock.test.ts test/case-path-unreachable.test.ts test/case-path.test.ts \
        test/chat-app-helpers.test.ts
      npm test -- test/chat-app-keyboard-scroll.test.ts test/chat-archive.test.ts test/chat-backup.test.ts test/chat-code-copy.test.ts \
        test/chat-employee-avatar.test.ts test/chat-exact-read.test.ts test/chat-header-actions.test.ts test/chat-image-broker-wire.test.ts \
        test/chat-image-paths.test.ts test/chat-link-file-swap.test.ts test/chat-link-file.test.ts test/chat-media.test.ts \
        test/chat-members-chip.test.ts test/chat-message-identity.test.ts test/chat-multi-delete.test.ts test/chat-open-window.test.ts \
        test/chat-phone-mic.test.ts test/chat-silent-owner-mention.test.ts test/chat-touch-hint.test.ts test/chat-web-pane.test.ts \
        test/chatroom-added-by.test.ts test/chatroom-delivery-escape.test.ts test/chatroom-delivery-images.test.ts \
        test/chatroom-delivery-reply.test.ts test/chatroom-delivery-spoken.test.ts test/chatroom-double-send.test.ts \
        test/chatroom-if-latest.test.ts test/chatroom-image-paths.test.ts test/chatroom-keyboard.test.ts test/chatroom-last-delivery.test.ts \
        test/chatroom-member-fold.test.ts test/chatroom-offline-names.test.ts test/chatroom-queued-chip.test.ts test/chatroom-roll.test.ts \
        test/chatroom-send-feedback.test.ts test/chatroom-store-dm.test.ts test/chatroom-unread-server.test.ts \
        test/check-browser-test-excludes.test.ts test/claude-cli-version-cache.test.ts test/claude-delivery-evidence.test.ts
      npm test -- test/claude-delivery-transcript.test.ts test/claude-paste-chip.test.ts test/claude-permission-mode.test.ts \
        test/claude-resume-title.test.ts test/claude-scrollback-strip.test.ts test/cleanup-manager.test.ts \
        test/cli-agent-chat-channels.test.ts test/cli-agent-chat-if-latest.test.ts test/cli-agent-chat-images.test.ts \
        test/cli-agent-chat-new.test.ts test/cli-agent-chat-nudge.test.ts test/cli-agent-chat-reply-to.test.ts \
        test/cli-agent-chat-room-default.test.ts test/cli-agent-chat-roster.test.ts test/cli-agent-hire-request.test.ts \
        test/cli-agent-journal-import.test.ts test/cli-agent-journal.test.ts test/cli-agent-poll-close.test.ts \
        test/cli-executable-resolver.test.ts test/cli-management-settings-ui.test.ts test/cli-newline-capability.test.ts \
        test/cli-registry-load.test.ts test/cli-registry-schema.test.ts test/cli-routine.test.ts test/cli-skill-target.test.ts \
        test/cli-style.test.ts test/cod54-hook-event-auth.test.ts test/codex-plan-usage.test.ts test/codex-reasoning-effort-schema.test.ts \
        test/codex-resume-alias-survives-start.test.ts test/codex-snapshot-replay.test.ts test/codex-terminal-output.test.ts \
        test/command-palette-ui.test.ts test/compaction-state.test.ts test/company-board-css.test.ts test/company-gpu-history-ui.test.ts \
        test/company-hire-requests-ui.test.ts test/company-hiring-ui.test.ts test/company-research-backend.test.ts \
        test/company-role-literals.test.ts
      npm test -- test/company-session-runtime.test.ts test/company-time-zone-ui.test.ts test/company-wake-ui.test.ts \
        test/config/instance.test.ts test/config/reverie-env.test.ts test/connection-indicator.test.ts test/connection-loss-ui.test.ts \
        test/create-case-modal-structure.test.ts test/credential-references.test.ts test/cron-docs.test.ts test/cron-go-live.test.ts \
        test/cron-run-preview.test.ts test/cron-schedule-preview.test.ts test/cron-time.test.ts test/ctrl-w-never-closes.test.ts \
        test/custom-model-endpoint-rediscovery.test.ts test/custom-model-injection-apply.test.ts \
        test/custom-model-injection-contract.test.ts test/custom-model-injection.test.ts test/custom-model-log-tail.test.ts \
        test/custom-model-one-shot-launch.test.ts test/custom-model-run-menu-ui.test.ts test/custom-model-swap-displacement.test.ts \
        test/daemon-control.test.ts test/debouncer.test.ts test/decision-alert.test.ts test/deepseek-cli-resolver.test.ts \
        test/deepseek-mode.test.ts test/deepseek-route-config.test.ts test/deepseek-status-shim.test.ts test/deepseek-transcript.test.ts \
        test/deepseek-web-server.test.ts test/delivery-format-contract.test.ts test/dependency-checker.test.ts \
        test/dependency-report.test.ts test/dependency-security.test.ts test/detached-session-pane-sizing.test.ts \
        test/discard-partially-built-session.test.ts test/docker-adopt-duplicate.test.ts test/docker-adopted-container.test.ts
      npm test -- test/docker-exec-options.test.ts test/docker-export.test.ts test/docker-hosts.test.ts test/docker-memory-policy.test.ts test/docker-self-update.test.ts \
        test/doctor-cli-json.test.ts test/document-conversion-limiter.test.ts test/document-preview-cache-eviction.test.ts \
        test/document-preview-cache.test.ts test/document-thumbnailer.test.ts test/dropped-output-recovery.test.ts \
        test/effort-injection.test.ts test/embassy-guest-client.test.ts test/embassy-guest-policy.test.ts test/embassy-guest-ui.test.ts \
        test/embassy-pairing-api-client.test.ts test/embassy-pairing-cancel-fence.test.ts test/embassy-pairing-cold-retirement.test.ts \
        test/embassy-pairing-protocol.test.ts test/embassy-pairing.test.ts test/embassy-qr.test.ts test/embassy-sidebar-errors.test.ts \
        test/employee-alert-mode.test.ts test/employee-journal-correction-chains.test.ts test/employee-journal-routes.test.ts \
        test/employee-journal.test.ts test/entrance-animations.test.ts test/env-overrides-schema.test.ts test/file-browser-hidden.test.ts \
        test/file-browser-search.test.ts test/file-editing-policy.test.ts test/file-link-click.test.ts test/file-path-link-forms.test.ts \
        test/file-picker-root-home.test.ts test/file-preview-detach.test.ts test/file-preview-html-page.test.ts \
        test/file-preview-markdown.test.ts test/file-preview-media.test.ts test/file-query.test.ts test/file-stream-manager.test.ts \
        test/focused-pane-shortcuts.test.ts
      npm test -- test/foldable-layout.test.ts test/folder-grid-ui.test.ts test/gemini-mode.test.ts \
        test/generated-artifact-attachments.test.ts test/git-clone.test.ts test/git-hooks.test.ts test/git-workspace-status.test.ts \
        test/github-job.test.ts test/grok-cli-resolver.test.ts test/grok-mode.test.ts test/header-icon-hover.test.ts \
        test/header-stats-style.test.ts test/heic-jpeg-core.test.ts test/help-modal-shortcuts.test.ts test/history-list-controls.test.ts \
        test/history-notice-reveal.test.ts test/history-truncation-notice.test.ts test/home-path-abbreviation.test.ts \
        test/home-screen-exited-rows.test.ts test/home-sessions.test.ts test/hook-secret-selfheal.test.ts test/hooks-config.test.ts \
        test/host-gpu.test.ts test/host-wake-banner.test.ts test/host-window-detach.test.ts test/http-contract.test.ts \
        test/http-range.test.ts test/i18n-branding.test.ts test/image-paste-trap.test.ts test/image-watcher.test.ts \
        test/independent-pairing-cold-retirement.test.ts test/input-cjk.test.ts test/input-socket-map.test.ts test/integration-flows.test.ts \
        test/intent-store.test.ts test/journal-map.test.ts test/keyboard-shortcuts.test.ts test/laptop-stop-agent-client.test.ts \
        test/link-provider-regex.test.ts test/local-echo-codex-gating.test.ts
      npm test -- test/location-overlay-commands.test.ts test/lru-map.test.ts test/markdown-anchors.test.ts test/markdown-sanitizer.test.ts \
        test/mcp-memory-tools.test.ts test/mcp-server.test.ts test/mcp-sync-registry.test.ts test/mcp-sync-targets.test.ts \
        test/mcp-sync.test.ts test/media-extension-parity.test.ts test/member-board-focus-server.test.ts test/member-board-focus.test.ts \
        test/member-picker.test.ts test/memory-brief.test.ts test/memory-leak-prevention.test.ts test/memory-restart-drill.test.ts \
        test/message-agent-bar.test.ts test/message-read-aloud.test.ts test/mobile-case-sheet-keyboard-lift.test.ts \
        test/mobile-folder-chip.test.ts test/mobile-header-buttons-policy.test.ts test/mobile-ime-preview-structure.test.ts \
        test/mobile-ime-preview.test.ts test/mobile-keyboard-bottom-padding.test.ts test/mobile-phone-row.test.ts \
        test/mobile-prompt-composer.test.ts test/mobile-shell-keyboard.test.ts test/mobile-tab-strip-chips.test.ts \
        test/mobile-tab-tap-zones.test.ts test/mobile-terminal-keys.test.ts test/mocks/mock-route-context-completeness.test.ts \
        test/multiuser-auth.test.ts test/mux-factory.test.ts test/network-auth-policy.test.ts test/network-host-guard.test.ts \
        test/nice-wrapper.test.ts test/nix-image-build.test.ts test/node-pty-repair.test.ts test/notification-manager-noise.test.ts \
        test/npm-release.test.ts
      npm test -- test/omp-cli-resolver.test.ts test/omp-fresh-run-no-resume.test.ts test/omp-mode.test.ts test/omp-session-resolver.test.ts \
        test/operation-lightspeed.test.ts test/orchestrator-loop.test.ts test/orchestrator-planner.test.ts \
        test/overlay-compositing-hittest.test.ts test/owner-alert.test.ts test/owner-login-guard.test.ts test/owner-stop-dead-viewer.test.ts \
        test/owner-stop-journal.test.ts test/owner-stop-process-admission.test.ts test/owner-stop-restore-production.test.ts \
        test/ownership-scoping.test.ts test/pane-dialog.test.ts test/pane-exit-sweep.test.ts test/pane-history-memory.test.ts \
        test/pane-survivors.test.ts test/paste-image-dir-shared.test.ts test/paste-image-gc.test.ts test/path-picker-hidden.test.ts \
        test/path-picker-sort.test.ts test/path-picker-ui.test.ts test/person-row-actions.test.ts test/phone-status-ui.test.ts \
        test/pi-cli-resolver.test.ts test/pi-mode.test.ts test/plan-move-auth.test.ts test/plan-move-processes.test.ts \
        test/plan-move-store.test.ts test/plan-move.test.ts test/plan-request-refusal-reason.test.ts test/plan-usage-chip.test.ts \
        test/plan-usage-collection-flip.test.ts test/plan-usage-latest.test.ts test/plan-usage-marks.test.ts test/plans-page-routes.test.ts \
        test/plans-roles.test.ts test/plans-statusline-usage.test.ts
      npm test -- test/plans-usage-resets.test.ts test/preview-envelope.test.ts test/previews-ui.test.ts test/proc-walk-bounds.test.ts \
        test/process-exit-wait.test.ts test/prompt-cache-status.test.ts test/pty-interactive.test.ts test/push-endpoint-validation.test.ts \
        test/push-forged-actions.test.ts test/push-payload-host-title.test.ts test/qr-auth.test.ts test/quick-start.test.ts \
        test/ralph-config.test.ts test/ralph-integration.test.ts test/ralph-loop-deep.test.ts test/ralph-loop.test.ts \
        test/ralph-prompt.test.ts test/ralph-tracker.test.ts test/read-aloud-per-room.test.ts test/read-aloud-settings.test.ts \
        test/readmymind-collectors.test.ts test/readmymind-context.test.ts test/readmymind-phone-key.test.ts \
        test/readmymind-predictor.test.ts test/redraw-toast-i18n.test.ts test/reliable-input-recovery.test.ts \
        test/remote-auto-reconnect.test.ts test/remote-discover-attach.test.ts test/remote-files.test.ts test/remote-hosts.test.ts \
        test/remote-kill-command.test.ts test/remote-pane-history.test.ts test/remote-shared-sessions.test.ts \
        test/remote-ssh-limiter.test.ts test/remote-ssh-options.test.ts test/repo-status.test.ts test/respawn-adaptive-timing.test.ts \
        test/respawn-controller.test.ts test/respawn-health.test.ts test/respawn-metrics.test.ts
      npm test -- test/respawn-patterns.test.ts test/respawn-pty-breaker.test.ts test/respawn-session-id-collision.test.ts \
        test/respawn-stop-race.test.ts test/respawn-team-awareness.test.ts test/response-viewer-external-links.test.ts \
        test/response-viewer-file-links.test.ts test/response-viewer-last-turn.test.ts test/response-viewer-transcript.test.ts \
        test/response-viewer-turn-segments.test.ts test/resume-alias-all-clis.test.ts test/resume-guard.test.ts \
        test/resume-history-mode-fidelity.test.ts test/resume-name.test.ts test/reverie-credentials.test.ts test/reverie-isolation.test.ts \
        test/review-cancel-preclaim-save-review.test.ts test/review-pairing-cancel-barrier-review.test.ts \
        test/review-pairing-cancel-status-review.test.ts test/review-pairing-cancel-ui.test.ts test/roles.test.ts \
        test/route-helpers-symlink-confinement.test.ts test/routes/agent-case-marker-routes.test.ts test/routes/agent-profile-routes.test.ts \
        test/routes/approval-routes.test.ts test/routes/case-clone-credential-helpers.test.ts test/routes/case-clone-routes.test.ts \
        test/routes/case-custom-path-routes.test.ts test/routes/case-routes.test.ts test/routes/chatroom-channels.test.ts \
        test/routes/chatroom-edit-pins.test.ts test/routes/chatroom-exact-read.test.ts test/routes/chatroom-if-latest-cutoff.test.ts \
        test/routes/chatroom-last-delivery.test.ts test/routes/chatroom-last-seen.test.ts test/routes/chatroom-media.test.ts \
        test/routes/chatroom-no-agent-targets.test.ts test/routes/chatroom-notify.test.ts test/routes/chatroom-order.test.ts \
        test/routes/chatroom-owner-marks.test.ts
      npm test -- test/routes/chatroom-parent-header.test.ts test/routes/chatroom-playback.test.ts test/routes/chatroom-polls.test.ts \
        test/routes/chatroom-replace.test.ts test/routes/chatroom-roles-messages.test.ts test/routes/chatroom-routes.test.ts \
        test/routes/chatroom-turn.test.ts test/routes/chatroom-wake.test.ts test/routes/chatroom-warnings.test.ts \
        test/routes/cli-registry-routes.test.ts test/routes/company-temporary-prune.test.ts test/routes/cron-scheduled-owner-only.test.ts \
        test/routes/custom-model-routes.test.ts test/routes/doctor-routes.test.ts test/routes/employee-alert-mode.test.ts \
        test/routes/external-cli-bypass-clamp.test.ts test/routes/file-routes-attachment-path-guard.test.ts \
        test/routes/file-routes-preview-thumbnail.test.ts test/routes/file-routes-range.test.ts test/routes/file-routes-remote.test.ts \
        test/routes/file-search-mode.test.ts test/routes/file-write-routes.test.ts test/routes/folder-grid-routes.test.ts \
        test/routes/git-status-routes.test.ts test/routes/hook-event-routes.test.ts test/routes/mcp-sync-routes.test.ts \
        test/routes/mux-routes.test.ts test/routes/orchestrator-routes.test.ts test/routes/owner-avatar.test.ts \
        test/routes/phone-status.test.ts test/routes/plan-routes.test.ts test/routes/ralph-routes.test.ts \
        test/routes/readmymind-routes.test.ts test/routes/reboot-restore-auto-pinned.test.ts \
        test/routes/reboot-restore-rebuild-failure.test.ts test/routes/remote-discover-routes.test.ts test/routes/respawn-routes.test.ts \
        test/routes/scheduled-routes.test.ts test/routes/search-routes.test.ts test/routes/session-create-unreachable-path.test.ts
      npm test -- test/routes/session-custom-model.test.ts test/routes/session-name-routes.test.ts \
        test/routes/session-opencode-thread.test.ts test/routes/session-order-routes.test.ts test/routes/session-pin-routes.test.ts \
        test/routes/session-remote-wake.test.ts test/routes/session-replacement-intent.test.ts test/routes/session-resume-guard.test.ts \
        test/routes/session-routes-agent-skill.test.ts test/routes/session-routes-claude-last-response.test.ts \
        test/routes/session-routes-claude-model.test.ts test/routes/session-routes-codex-last-response.test.ts \
        test/routes/session-routes-external-cli-last-response.test.ts test/routes/session-routes-parent-lineage.test.ts \
        test/routes/session-routes-tab-group.test.ts test/routes/session-routes-workspace-hooks.test.ts test/routes/session-routes.test.ts \
        test/routes/session-wait-output-routes.test.ts test/routes/session-wait-routes.test.ts test/routes/status-telemetry-routes.test.ts \
        test/routes/system-routes-settings-get-plan-usage-default.test.ts test/routes/system-routes-tunnel-guard.test.ts \
        test/routes/system-span-displays.test.ts test/routes/tab-layout-routes.test.ts test/routes/team-routes.test.ts \
        test/routes/unified-sessions-routes.test.ts test/routes/webview-routes.test.ts test/routes/workflow-routes.test.ts \
        test/routes/workspace-icons.test.ts test/routes/ws-routes.test.ts test/routine-notice-noreply.test.ts test/routine-notice.test.ts \
        test/routines-author.test.ts test/routines-delegation.test.ts test/run-mode-dispatch.test.ts test/run-mode-menu-scroll.test.ts \
        test/run-mode-ui.test.ts test/scheduled-layout-registration.test.ts test/screenshot-capture.test.ts test/search-service.test.ts
      npm test -- test/security-regression.test.ts test/sensitive-path.test.ts test/service-auth-config.test.ts \
        test/service-auth-shipped-config.test.ts test/service-decision.test.ts test/service-grant-auth.test.ts \
        test/service-grant-canonical.test.ts test/service-grant-server.test.ts test/service-lifecycle.test.ts \
        test/services/unified-session-service.test.ts test/session-attachment-history.test.ts test/session-auto-name.test.ts \
        test/session-auto-resume.test.ts test/session-awaiting-workers.test.ts test/session-claude-conversation-chain.test.ts \
        test/session-close-fallback.test.ts test/session-config-model.test.ts test/session-display-model.test.ts \
        test/session-history-index.test.ts test/session-interactive-recovery.test.ts test/session-lineage-lines.test.ts \
        test/session-list-layout.test.ts test/session-listener-wiring.test.ts test/session-manager.test.ts \
        test/session-options-structure.test.ts test/session-order-sse.test.ts test/session-order.test.ts test/session-overview-order.test.ts \
        test/session-pane-exit-ui.test.ts test/session-pane-exit.test.ts test/session-pin.test.ts test/session-prompt-cache.test.ts \
        test/session-resize-arbitration.test.ts test/session-restart-intent.test.ts test/session-retired-hidden.test.ts \
        test/session-select-ack-gate.test.ts test/session-settings-recovery.test.ts test/session-sidebar-ux.test.ts \
        test/session-state.test.ts test/session-submit-anchor.test.ts
      npm test -- test/session-switcher.test.ts test/session-trust-dialog.test.ts test/session-wait-registry.test.ts \
        test/session-watching.test.ts test/session-worktree-label.test.ts test/session.test.ts test/settings-apply-button.test.ts \
        test/shell-scroll-history-pull.test.ts test/shell-session-launch.test.ts test/shift-enter-keypress-swallowed.test.ts \
        test/shortcut-registry-overlay.test.ts test/signal-target.test.ts test/skin-themes.test.ts test/spawned-tabs-follow-setting.test.ts \
        test/split-pane-auto-collapse-unit.test.ts test/split-pane-headers.test.ts test/split-pane-helpers.test.ts \
        test/split-pane-hidden-button-css.test.ts test/split-pane-per-device-setting.test.ts \
        test/split-pane-picker-listener-leak-unit.test.ts test/spreadsheet-preview.test.ts \
        test/spreadsheet-xlsx-core.test.ts test/sse-cors-headers.test.ts test/sse-dispatch-table.test.ts test/sse-events.test.ts \
        test/sse-heartbeat.test.ts test/sse-registry-parity.test.ts test/sse-routing-remote.test.ts test/sse-staleness.test.ts \
        test/sse-subscription-filter.test.ts test/sse-tile-grid-filter.test.ts test/stale-expiration-map.test.ts \
        test/stalled-seat-alert.test.ts test/stalled-seat-notice-resolution.test.ts test/stalled-seat-notice-routing.test.ts \
        test/state-store-tab-layout.test.ts test/state-store.test.ts test/static-cache-headers.test.ts \
        test/status-telemetry-attribution.test.ts
      npm test -- test/string-utilities.test.ts test/strip-ink-redraw-bloat.test.ts test/subagent-watcher.test.ts \
        test/subscription-ui.test.ts test/sw-fetch-skip.test.ts test/sw-precache-manifest.test.ts test/tab-cli-logos-setting.test.ts \
        test/tab-clusters.test.ts test/tab-families.test.ts test/tab-focus-browser.test.ts test/tab-focus-rail.test.ts \
        test/tab-group-launch.test.ts test/tab-layout-browser.test.ts test/tab-layout-editing.test.ts test/tab-layout-focus.test.ts \
        test/tab-layout-grouped-create.test.ts test/tab-layout-legacy-order.test.ts test/tab-layout-persistence.test.ts \
        test/tab-layout-rail.test.ts test/tab-layout-restore-gate.test.ts test/tab-layout-service.test.ts \
        test/tab-layout-settings-i18n.test.ts test/tab-layout-sse.test.ts test/tab-layout.test.ts test/tab-name-rename-unclamp.test.ts \
        test/tab-orientation.test.ts test/tab-overflow.test.ts test/tab-rail-order.test.ts test/tab-rail-resize.test.ts \
        test/tab-rail-search.test.ts test/tab-triage.test.ts test/task-queue.test.ts test/task-tracker.test.ts test/task.test.ts \
        test/team-watcher.test.ts test/templates.test.ts test/terminal-auto-copy.test.ts test/terminal-buffer-flush.test.ts \
        test/terminal-copy-clean.test.ts test/terminal-copy-selection.test.ts
      npm test -- test/terminal-flush-budget.test.ts test/terminal-font-settle.test.ts test/terminal-font-weight.test.ts \
        test/terminal-font.test.ts test/terminal-history-schema.test.ts test/terminal-history.test.ts \
        test/terminal-keycode229-recovery.test.ts test/terminal-layout-css.test.ts test/terminal-link-provider-target.test.ts \
        test/terminal-logical-line.test.ts test/terminal-osc52-clipboard.test.ts test/terminal-parsing.test.ts \
        test/terminal-pty-geometry.test.ts test/terminal-resilience.test.ts test/terminal-resize-observer-survives-init.test.ts \
        test/terminal-scroll-intent.test.ts test/terminal-scroll-routing.test.ts test/terminal-shift-drag-selection.test.ts \
        test/terminal-tile-input.test.ts test/terminal-tile-scroll.test.ts test/terminal-tile-unit.test.ts test/terminal-touch-tap.test.ts \
        test/test-env-isolation.test.ts test/test-ports-guard.test.ts test/test-suite-partition.test.ts test/tile-grid-attach.test.ts \
        test/tile-grid-auto-join.test.ts test/tile-grid-cap.test.ts test/tile-grid-cells.test.ts test/tile-grid-chrome.test.ts \
        test/tile-grid-close-fallback.test.ts test/tile-grid-count-helpers.test.ts test/tile-grid-count-menu.test.ts \
        test/tile-grid-detach.test.ts test/tile-grid-dividers.test.ts test/tile-grid-entrance-styles.test.ts \
        test/tile-grid-entry-points.test.ts test/tile-grid-file-drop.test.ts test/tile-grid-hint.test.ts test/tile-grid-i18n.test.ts
      npm test -- test/tile-grid-layout-memory.test.ts test/tile-grid-layout.test.ts test/tile-grid-load-queue.test.ts \
        test/tile-grid-motion.test.ts test/tile-grid-move.test.ts test/tile-grid-open-set.test.ts test/tile-grid-paced-connect.test.ts \
        test/tile-grid-park-guards.test.ts test/tile-grid-per-device-setting.test.ts test/tile-grid-ranking.test.ts \
        test/tile-grid-restore.test.ts test/tile-grid-select-branch.test.ts test/tile-grid-shortcuts.test.ts \
        test/tile-grid-split-coexistence.test.ts test/tile-grid-sse-filter.test.ts test/tile-grid-zoom.test.ts \
        test/tmux-capture-color.test.ts test/tmux-capture-full-history.test.ts test/tmux-restart-recovery.test.ts \
        test/tmux-scrollback-eol.test.ts test/tmux-window-size-query.test.ts test/toast-display-time.test.ts test/toolbar-attach.test.ts \
        test/transcript-watcher.test.ts test/tui/tui-ansi.test.ts test/tui/tui-app.test.ts test/tui/tui-approvals.test.ts \
        test/tui/tui-client-sse.test.ts test/tui/tui-client.test.ts test/tui/tui-composer.test.ts test/tui/tui-digest.test.ts \
        test/tui/tui-e2e.test.ts test/tui/tui-keys.test.ts test/tui/tui-layout.test.ts test/tui/tui-model.test.ts \
        test/tui/tui-render.test.ts test/tui/tui-sse.test.ts test/types.test.ts test/ui-update-visibility.test.ts test/update-notice.test.ts
      npm test -- test/usage-limit-patterns.test.ts test/usage-telemetry.test.ts test/user-store.test.ts \
        test/utils/buffer-accumulator.test.ts test/utils/cleanup-manager.test.ts test/utils/lru-map.test.ts \
        test/utils/stale-expiration-map.test.ts test/validation-utilities.test.ts test/viewport-shape-change.test.ts \
        test/voice-input-target.test.ts test/voice-turn-heard.test.ts test/voice-turn-trace.test.ts test/wake-composer-ownership.test.ts \
        test/watching-no-alert.test.ts test/webhook-removal.test.ts test/webserver-bound-port.test.ts test/webview-auth-exemption.test.ts \
        test/webview-capability-revocation.test.ts test/webview-egress-policy.test.ts test/webview-egress.test.ts \
        test/webview-loopback-links.test.ts test/webview-lost-root-frame.test.ts test/webview-menu-rows.test.ts \
        test/webview-proxy-timeout.test.ts test/webview-proxy.test.ts test/webview-sse.test.ts test/wiki-home-index.test.ts \
        test/workflow-run-watcher.test.ts test/working-directory-schema.test.ts test/workspace-hooks-unreachable-mount.test.ts \
        test/ws-connection-registry.test.ts test/ws-reconnect-plan.test.ts test/ws-state-lifecycle.test.ts test/xterm-private-api.test.ts
      # memoryPackage's Python discovery never depends on the console output.
      PYTHONPATH="$PWD/test/fixtures/goal-source/python" \
        OWN_TEST_NODE="${pkgs.nodejs_22}/bin/node" \
        OWNER_TERMINAL_TEST_DIST="$PWD/dist" \
        OWNER_TERMINAL_TEST_CONNECTOR="$PWD/scripts/connect-owner-terminal.mjs" \
        NIX_REVERIE_TEST_NODE_CUSTODY=1 \
        python3 -B test/fixtures/owner-terminal/test_bridge.py
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --ignore-scripts
      mkdir -p "$out/lib/reverie" "$out/bin"
      cp -r dist node_modules package.json skills scripts packages LICENSE "$out/lib/reverie/"
      # node-gyp's build metadata references the download cache and the Node.js
      # source tree (the generated Makefile and *.mk files); none of it is needed
      # to load the compiled PTY module (build/Release/pty.node) at runtime.
      find "$out/lib/reverie/node_modules" -path '*/node-pty/build/config.gypi' -delete
      find "$out/lib/reverie/node_modules" \( -path '*/node-pty/build/Makefile' -o -path '*/node-pty/*.mk' \) -delete
      makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/reverie" \
        --prefix PATH : ${lib.getBin pkgs.util-linux}/bin \
        --set-default REVERIE_RUST_ROUTE_HANDLER ${rustRouteHandler}/bin/reverie-route-handler \
        --add-flags "$out/lib/reverie/dist/index.js"
      runHook postInstall
    '';
    meta = { mainProgram = "reverie"; license = lib.licenses.mit; platforms = lib.platforms.linux; };
  };
  interpreterReadyFixture = import ./interpreter-ready-fixture.nix { inherit pkgs src; };
  # Explicit noncircular ABI fixture: PATH may select the bare interpreter in
  # buildPythonPackage checks even while this environment runs the suite.
  pythonCheckEnvironment = pkgs.python3.withPackages (ps: [ ps.pillow ps.aiohttp ]);
  memoryPackage = pkgs.python3Packages.buildPythonPackage {
    NIX_REVERIE_TEST_INTERPRETER_READY_WRAPPER = "${interpreterReadyFixture}/bin/python3";
    NIX_REVERIE_TEST_PYTHON_ENV_WRAPPER = "${pythonCheckEnvironment}/bin/python3";
    pname = "reverie-memory";
    version = "0.1.0";
    inherit src;
    pyproject = true;
    postUnpack = ''sourceRoot="$sourceRoot/python"'';
    build-system = [ pkgs.python3Packages.setuptools ];
    nativeCheckInputs = [ pkgs.bash pkgs.coreutils pkgs.git pkgs.nodejs_22 pkgs.tmux pkgs.jq (lib.getBin pkgs.util-linux) pkgs.python3Packages.pillow pkgs.python3Packages.aiohttp ];
    postPatch = "patchShebangs ../scripts ../docker ../.github/ci";
    checkPhase = ''
      (cd ..; PYTHONPATH="$PWD/python" PYTHONWARNINGS=ignore::ResourceWarning ${pythonCheckEnvironment}/bin/python3 -m unittest discover -s tests -t .)
      (cd ..; node --test tests/test_web_install_manifest.mjs tests/test_cli_installer.mjs tests/test_reverie_start.mjs tests/test_recovery_scripts.mjs tests/test_opencode_plugin.mjs tests/test_model_relay.mjs tests/test_voice_ci_launch.mjs)
    '';
  };
  memory = pkgs.python3.withPackages (ps: [ memoryPackage ps.pillow ps.pytest ]);
  kokoro = import ./kokoro.nix { inherit pkgs memoryPackage; };
  hands = pkgs.writeShellApplication {
    name = "reverie-hands";
    runtimeInputs = [ memory ];
    text = ''exec python3 -I -B ${memoryPackage}/${pkgs.python3.sitePackages}/reverie/hands/launcher.py "$@"'';
  };
  adminMemory = pkgs.writeShellApplication {
    name = "reverie-admin-memory";
    runtimeInputs = [ memory ];
    text = ''exec python3 -I -B ${memoryPackage}/${pkgs.python3.sitePackages}/reverie/hands/memory_access.py "$@"'';
  };
  handsToolchain = pkgs.buildEnv {
    name = "reverie-hands-toolchain";
    paths = [ pkgs.python3 pkgs.nodejs_22 pkgs.bashInteractive pkgs.coreutils
      pkgs.git pkgs.ripgrep pkgs.findutils pkgs.gnused pkgs.gnugrep pkgs.gnumake ];
    pathsToLink = [ "/bin" ];
  };
  handsToolsSource = pkgs.runCommand "reverie-hands-workspace-tools" { } ''
    mkdir -p "$out"
    cp ${src}/python/reverie/hands/laptop_tools.py "$out/laptop_tools.py"
    cp ${src}/python/reverie/hands/workspace_dispatch.py "$out/workspace_dispatch.py"
    cp ${src}/python/reverie/hands/coding_telemetry.py "$out/coding_telemetry.py"
    cp ${src}/python/reverie/hands/command_telemetry.py "$out/command_telemetry.py"
    cp ${src}/python/reverie/hands/command_catalog.py "$out/command_catalog.py"
  '';
  handsTools = pkgs.writeShellApplication {
    name = "reverie-hands-tools";
    runtimeInputs = [ pkgs.python3 ];
    text = ''exec python3 -I -B ${handsToolsSource}/laptop_tools.py --tool-path ${handsToolchain}/bin "$@"'';
  };
  modelRelaySource = pkgs.writeText "reverie-model-relay.mjs" (builtins.readFile (src + "/apps/host/model-relay.mjs"));
  modelRelay = pkgs.writeShellApplication {
    name = "reverie-model-relay";
    runtimeInputs = [ pkgs.nodejs_22 ];
    text = ''exec node ${modelRelaySource} "$@"'';
  };
  officeRelay = pkgs.writeShellApplication {
    name = "reverie-office-relay";
    runtimeInputs = [ pkgs.nodejs_22 ];
    text = ''
      exec node --input-type=module -e 'import {modelRelay} from "${modelRelaySource}"; const server=modelRelay("/run/reverie-office/office.sock",8093,"Reverie office connection is unavailable."); server.on("error",()=>process.exit(1));'
    '';
  };
  lockTools = pkgs.runCommand "reverie-lock-tools" { } ''
    mkdir -p "$out/bin"
    ln -s ${lib.getBin pkgs.util-linux}/bin/flock "$out/bin/flock"
  '';
  nativeClient = import ./worker-client.nix { inherit pkgs src; };
  workerNativeClient = nativeClient.program;
  workerNativeClientManifest = nativeClient.manifest;
  # All client modes and the protected manifest move together; no Python branch.
  workerResourceClientManifest = workerNativeClientManifest;
  workerExec = workerNativeClient;
  workerChild = pkgs.writeShellScriptBin "reverie-worker-child" ''
    exec ${memory}/bin/python3 -m reverie.worker child "$@"
  '';
  # NSS 3.131.1 drops the emSign ECC Root CA - C3, emSign ECC Root CA - G3 and emSign Root CA - C1 roots after the
  # eMudhra intermediate CA compromise (Python CVE-2026-115557). The pinned nixpkgs carries 3.126; only the bundled
  # certdata.txt differs, so this is data-only and nothing else is rebuilt against it.
  cacert = pkgs.cacert.overrideAttrs (old: {
    version = "3.131.1";
    src = pkgs.fetchurl {
      urls = [
        "https://hg-edge.mozilla.org/projects/nss/raw-file/NSS_3_131_1_RTM/lib/ckfw/builtins/certdata.txt"
        "https://raw.githubusercontent.com/nss-dev/nss/refs/tags/NSS_3_131_1_RTM/lib/ckfw/builtins/certdata.txt"
      ];
      hash = "sha256-PsK00kDcEsdH6vRQBh24SvdXxIO72jAvninOtdcL5RA=";
    };
  });
  laptopTools = import ./laptop-tools.nix { inherit pkgs src; };
  runtime = pkgs.buildEnv {
    name = "reverie-runtime";
    paths = [ console memory kokoro modelRelay officeRelay hands adminMemory handsTools workerExec workerChild pkgs.nodejs_22 pkgs.tmux pkgs.git pkgs.ripgrep
      pkgs.curl pkgs.coreutils pkgs.bashInteractive pkgs.gnugrep pkgs.gnused
      pkgs.gawk pkgs.findutils pkgs.gnutar pkgs.gzip pkgs.procps pkgs.which pkgs.gnumake pkgs.gcc
      pkgs.gh pkgs.jq pkgs.diffutils pkgs.fd
      cacert lockTools ] ++ providerLaunchers;
    pathsToLink = [ "/bin" "/share" ];
    # The images' /etc/ssl/certs comes from this same bundle (nix/image.nix).
    passthru = { inherit cacert; };
  };
  entrypoint = pkgs.writeShellScript "reverie-start" (builtins.readFile (src + "/docker/entrypoint.sh"));
  requestUpdate = pkgs.writeShellApplication {
    name = "reverie-request-update";
    runtimeInputs = [ pkgs.coreutils ];
    text = lib.removePrefix "#!/usr/bin/env bash\n" (builtins.readFile (src + "/scripts/reverie-request-update"));
  };
  cliInstallerSource = pkgs.writeText "reverie-install-clis.mjs"
    (builtins.readFile (src + "/scripts/reverie-install-clis.mjs"));
  installClis = pkgs.writeShellApplication {
    name = "reverie-install-clis";
    runtimeInputs = [ pkgs.nodejs_22 pkgs.coreutils lockTools pkgs.patchelf ];
    text = ''
      export REVERIE_ELF_PATCHER=${pkgs.patchelf}/bin/patchelf
      export REVERIE_ELF_INTERPRETER=${pkgs.stdenv.cc.bintools.dynamicLinker}
      export REVERIE_ELF_LIBRARY_PATH=${lib.makeLibraryPath [ pkgs.glibc pkgs.stdenv.cc.cc.lib pkgs.zlib pkgs.openssl ]}
      exec node ${cliInstallerSource} "$@"
    '';
  };
  providerLauncherSource = pkgs.writeText "reverie-provider-cli"
    (builtins.readFile (src + "/scripts/reverie-provider-cli"));
  providerLaunchers = map (provider: pkgs.writeShellScriptBin provider ''
    export PATH=${pkgs.nodejs_22}/bin:${pkgs.coreutils}/bin:${lockTools}/bin:$PATH
    exec ${pkgs.bash}/bin/bash ${providerLauncherSource} ${provider} ${installClis}/bin/reverie-install-clis "$@"
  '') [ "claude" "codex" "opencode" ];
  launcher = pkgs.writeShellScript "reverie-launcher" ''
    export PATH=${installClis}/bin:${runtime}/bin:$PATH
    export REVERIE_MCP_MEMORY_PYTHON=${memory}/bin/python3
    export REVERIE_MANAGED_INSTALL=nix
    export REVERIE_OWNER_SETUP=1
    export REVERIE_NIX_LAUNCHER="$0"
    export REVERIE_ROOT="''${REVERIE_ROOT:-$HOME/reverie}"
    export REVERIE_VERSION=${manifest.version}
    export REVERIE_FLOCK_BIN=${lib.getBin pkgs.util-linux}/bin/flock
    if [ "''${REVERIE_CONTAINER:-0}" = 1 ]; then
      export REVERIE_DATA="''${REVERIE_DATA:-/instances/default}"
    else
      export REVERIE_DATA="''${REVERIE_DATA:-$REVERIE_ROOT/companies/default/data}"
      export TMPDIR="''${TMPDIR:-$REVERIE_ROOT/scratch/tmp}"
      mkdir -p "$TMPDIR"
    fi
    export REVERIE_DATA_DIR="''${REVERIE_DATA_DIR:-$REVERIE_DATA/console}"
    export CLAUDE_CONFIG_DIR="''${CLAUDE_CONFIG_DIR:-$REVERIE_DATA/accounts/claude}"
    export CODEX_HOME="''${CODEX_HOME:-$REVERIE_DATA/accounts/codex}"
    if [ "''${1:-}" = web ] && [ "''${REVERIE_CONTAINER:-0}" != 1 ]; then
      exec ${entrypoint} ${console}/bin/reverie "$@"
    fi
    exec ${console}/bin/reverie "$@"
  '';
  # Runtime dependencies stay private so installing Reverie does not replace a
  # user's existing Node, Python, Codex, OpenCode, Git or compiler commands.
  reverie = pkgs.runCommand "reverie-${manifest.version}" {
    nativeBuildInputs = [ pkgs.makeWrapper ];
    meta = { mainProgram = "reverie"; license = lib.licenses.mit; platforms = lib.platforms.linux; };
    passthru = { inherit console memory runtime; };
  } ''
    mkdir -p "$out/bin"
    ln -s ${launcher} "$out/bin/reverie"
    ln -s ${requestUpdate}/bin/reverie-request-update "$out/bin/reverie-request-update"
    ln -s ${installClis}/bin/reverie-install-clis "$out/bin/reverie-install-clis"
    ln -s ${kokoro}/bin/reverie-kokoro "$out/bin/reverie-kokoro"
    ln -s ${hands}/bin/reverie-hands "$out/bin/reverie-hands"
    ln -s ${adminMemory}/bin/reverie-admin-memory "$out/bin/reverie-admin-memory"
    for command in ${memory}/bin/reverie-*; do
      makeWrapper "$command" "$out/bin/$(basename "$command")" \
        --prefix PATH : ${runtime}/bin \
        --set REVERIE_MCP_MEMORY_PYTHON ${memory}/bin/python3
    done
  '';

in { inherit reverie console memory memoryPackage runtime entrypoint kokoro hands handsTools workerExec workerResourceClientManifest workerNativeClient workerNativeClientManifest laptopTools rustRouteHandler; }
