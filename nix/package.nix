{ pkgs, src }:
let
  lib = pkgs.lib;
  manifest = builtins.fromJSON (builtins.readFile (src + "/apps/web/package.json"));
  consoleSkill = lib.cleanSource (src + "/skills/reverie");
  goalPythonFixture = lib.cleanSource (src + "/python/reverie");
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
      cp ${src}/python/reverie/{__init__,resume_ledger,resume_ledger_rpc}.py test/fixtures/recovery-ledger/reverie/
      # The web derivation is flattened to apps/web. Supply explicit trusted
      # offline test sources; tests must not escape /build/source to find them.
      mkdir -p test/fixtures/goal-source/python test/fixtures/goal-source/tests
      cp -r ${goalPythonFixture} test/fixtures/goal-source/python/reverie
      cp ${src}/tests/__init__.py ${src}/tests/goal_private_fixture.py ${src}/tests/goal_broker_fixture.py test/fixtures/goal-source/tests/
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
        test/company-service.test.ts test/company-hierarchy.test.ts \
        test/owner-auth-admin-grant.test.ts test/owner-auth-review.test.ts \
        test/experts-api.test.ts test/experts-delegated-server.test.ts test/delegated-session-create.test.ts test/self-update.test.ts \
        test/owner-auth-lock-portability.test.ts test/company-full-page.test.ts \
        test/service-installer.test.ts test/company-wake.test.ts test/host-worker-resume.test.ts test/host-worker-resume-reconnect.test.ts \
        test/company-recovery-prompt.test.ts test/company-wake-server.test.ts \
        test/goal-lifecycle.test.ts test/goal-lifecycle-transactions.test.ts test/goal-api-auth.test.ts \
        test/goal-response-privacy.test.ts test/goal-successor-independent.test.ts \
        test/goal-server-integration.test.ts test/goal-server-unavailable.test.ts test/goal-server-policy.test.ts \
        test/goal-canonical-authority.test.ts \
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
        test/managed-codex-trust.test.ts test/full-access-default.test.ts test/worker-execution.test.ts test/laptop-power.test.ts test/laptop-reconnect.test.ts test/worker-viewer-reconnect.test.ts test/worker-provider-health.test.ts \
        test/command-failure-routes.test.ts test/command-failure-ui.test.ts \
        test/expert-runtime-recipe.test.ts test/company-employee-restart.test.ts test/company-restart-ui.test.ts test/routes/session-mode-switch.test.ts \
        test/claude-plan-usage.test.ts test/claude-usage-display.test.ts test/subscription-usage.test.ts test/plan-usage-compliance.test.ts test/plan-pace.test.ts \
        test/plan-agent-burn.test.ts test/plan-agent-burn-wiring.test.ts test/plan-agent-burn-ui.test.ts test/plan-move-impact-policy.test.ts \
        test/member-menu.test.ts test/menu-viewport.test.ts test/render-index-html.test.ts test/asset-content-version.test.ts \
        test/company-plans-navigation.test.ts test/company-plans-width.test.ts test/plan-five-hour-ui.test.ts \
        test/plan-move-runtime.test.ts test/plan-move-routes.test.ts test/plan-move-company.test.ts test/plan-move-launch.test.ts \
        test/plan-move-resources.test.ts test/plan-move-resource-runtime.test.ts \
        test/resource-owner-authority.test.ts test/resource-native-client.test.ts \
        test/company-resource-binding-cas.test.ts test/resource-session-publication.test.ts \
        test/resource-replacement-controller.test.ts test/company-laptop-memory-ui.test.ts \
        test/agent-plan-server.test.ts test/agent-plan-request.test.ts test/plan-request.test.ts test/plan-request-capability.test.ts test/plan-request-routes.test.ts test/plan-credential-boundary.test.ts test/plan-request-ui.test.ts test/plan-request-prompt.test.ts \
        test/embassy-builtin.test.ts test/embassy-protocol-server.test.ts test/embassy-pairing-ui.test.ts \
        test/disk-stats.test.ts test/disk-stats-ui.test.ts test/routes/system-routes.test.ts test/shared-attachments.test.ts test/routes/file-routes.test.ts \
        test/chat-language-service.test.ts test/chat-plugins.test.ts test/chat-math-plugin.test.ts test/chat-code-highlighting.test.ts test/workspace-files.test.ts test/workspace-files-safety.test.ts test/workspace-publisher.test.ts \
        test/office-accounts.test.ts test/human-presence-ui.test.ts test/human-mentions-ui.test.ts test/bots-page.test.ts test/bots-ui.test.ts test/bot-avatar.test.ts test/cron-service.test.ts test/office-navigation-ui.test.ts test/workspace-files-ui.test.ts test/preview-routes.test.ts
      npm test -- test/agent-capabilities.test.ts test/chat-plugin-settings.test.ts test/resource-history.test.ts
      npm test -- test/browser-job-evidence.test.ts
      npm test -- test/routes/chatroom-clear-history.test.ts test/chat-dm-clear-history-ui.test.ts
      npm test -- test/file-preview-source-reader.test.ts test/file-preview-sources-ui.test.ts \
        test/file-preview-worker-policy.test.ts test/workspace-preview-source.test.ts \
        test/pdf-preview-terminal-state.test.ts test/pdf-preview-worker-cancellation.test.ts
      npm test -- test/cli-help.test.ts test/cli-commands.test.ts test/chat-ui-controls.test.ts \
        test/member-sorting.test.ts test/company-profile-layout.test.ts test/company-space-ui.test.ts \
        test/github-watches-ui.test.ts test/office-footer-panel.test.ts
      npm test -- test/board-permissions.test.ts test/owner-auth-board-decisions.test.ts \
        test/publication-credentials.test.ts test/publication-routes.test.ts test/credential-status.test.ts \
        test/employee-context.test.ts test/employee-context-routes.test.ts test/cli-agent-context.test.ts \
        test/company-board-permissions-ui.test.ts test/company-publication-ui.test.ts \
        test/company-reporting-ui.test.ts test/company-core-context-ui.test.ts
      NIX_REVERIE_TEST_ROOT_CUSTODY=1 npm test -- test/cli-agent-credentials.test.ts
      npm test -- test/routes/chat-attention.test.ts test/url-session-fragment.test.ts test/company-lifecycle-fence.test.ts
      npm test -- test/assignment-status-watch.test.ts test/assignment-exact-read.test.ts test/display-time.test.ts test/assignment-refused-reservation.test.ts test/public-issue-watch.test.ts \
        test/bot-watches-runtime.test.ts test/bot-watch-durable-chat.test.ts test/bot-watch-state.test.ts \
        test/github-repository-watch-source.test.ts test/github-repository-watches.test.ts \
        test/github-repository-watch-routes.test.ts test/chat-bot-commit-authority.test.ts
      # The console owns this Python/Node composition check after its TS build.
      npm test -- test/owner-terminal-routes.test.ts test/owner-terminal-ui.test.ts
      npm test -- test/submit-settle.test.ts test/session-submit-verifier.test.ts \
        test/chatroom-delivery-receipts.test.ts test/codex-chat-submit-ownership.test.ts test/chatroom-delivery-held-seat.test.ts
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
  # The protected resource bootstrap pins this manifest, rather than inferring
  # an interpreter or package import path from the website's environment.
  workerResourceClientManifest = pkgs.runCommand "reverie-resource-client-manifest" {
    nativeBuildInputs = [ pkgs.buildPackages.python3 ];
  } ''
    mkdir -p "$out/share/reverie"
    export REVERIE_RESOURCE_CLIENT_OUTPUT="$out/share/reverie/resource-client.json"
    ${pkgs.buildPackages.python3}/bin/python3 -I -B <<'PY'
    import hashlib, json, os
    from pathlib import Path
    invocation = "${pkgs.python3}/bin/python3"
    executable = Path(invocation).resolve(strict=True)
    entry = Path("${workerPythonSource}/python/reverie/worker.py")
    assert str(executable).startswith('/nix/store/') and executable.is_file()
    with executable.open('rb') as stream:
        assert stream.read(4) == b'\x7fELF', 'The private client requires a native Python ELF'
    assert entry.resolve(strict=True) == entry and entry.is_file()
    value = {
        'version': 1,
        'purpose': 'resource-replacement-client-v1',
        'pythonInvocation': invocation,
        'pythonExecutable': str(executable),
        'entry': str(entry),
        'entrySHA256': hashlib.sha256(entry.read_bytes()).hexdigest(),
        'argvPrefix': [invocation, '-I', '-B', str(entry), 'client'],
    }
    Path(os.environ['REVERIE_RESOURCE_CLIENT_OUTPUT']).write_text(json.dumps(value, indent=2) + '\n')
    PY
  '';
  # The resource client runs worker.py by path beside its sibling modules. Ship
  # only the Python tree: referencing the whole source tree put the checkout
  # (about 300 MB) into every image that carries the runtime.
  workerPythonSource = pkgs.runCommand "reverie-worker-python-source" { } ''
    mkdir -p "$out"
    cp -R ${src}/python "$out/python"
  '';
  workerExec = pkgs.writeShellScriptBin "reverie-worker-exec" ''
    # Protected bootstrap metadata: ${workerResourceClientManifest}/share/reverie/resource-client.json
    if [ "''${1:-}" = --resource-ref ]; then
      exec ${pkgs.python3}/bin/python3 -I -B ${workerPythonSource}/python/reverie/worker.py client "$@"
    fi
    exec ${memory}/bin/python3 -m reverie.worker client "$@"
  '';
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

in { inherit reverie console memory memoryPackage runtime entrypoint kokoro hands handsTools workerExec workerResourceClientManifest; }
