{ pkgs, src }:
let
  lib = pkgs.lib;
  manifest = builtins.fromJSON (builtins.readFile (src + "/apps/web/package.json"));
  consoleSkill = lib.cleanSource (src + "/skills/reverie");
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
    '';
    preBuild = "npm rebuild node-pty esbuild --offline --ignore-scripts=false";
    doCheck = true;
    nativeCheckInputs = [ pkgs.git pkgs.tmux pkgs.curl pkgs.which (lib.getBin pkgs.util-linux) ];
    checkPhase = ''
      runHook preCheck
      npm test -- test/company-recover.test.ts test/routes/company-routes.test.ts \
        test/cli-agent-chat-fetch.test.ts test/cli-agent-chat-stdin.test.ts test/cli-agent-chat-file.test.ts \
        test/chat-bot-presets.test.ts test/cron-post-bot.test.ts test/cron-post-security.test.ts \
        test/chatroom-delivery-modes.test.ts test/routes/polling-membership.test.ts \
        test/company-service.test.ts test/company-hierarchy.test.ts \
        test/owner-auth-admin-grant.test.ts test/owner-auth-review.test.ts \
        test/experts-api.test.ts test/experts-delegated-server.test.ts test/delegated-session-create.test.ts test/self-update.test.ts \
        test/owner-auth-lock-portability.test.ts test/company-full-page.test.ts \
        test/service-installer.test.ts test/company-wake.test.ts \
        test/company-recovery-prompt.test.ts test/company-wake-server.test.ts \
        test/owner-auth-fresh-enforce.test.ts test/routines-owner-middleware.test.ts \
        test/routine-announcement-room.test.ts test/routine-announcement-server.test.ts \
        test/owner-auth-board-decisions.test.ts test/board-decision-options.test.ts test/cli-board.test.ts test/routes/board-routes.test.ts \
        test/office-power-ui.test.ts test/company-lifecycle-fence.test.ts test/github-source.test.ts test/owner-first-setup.test.ts \
        test/owner-auth.test.ts test/owner-route-principals.test.ts test/routines-grants-owner.test.ts test/owner-setup-ui.test.ts \
        test/owner-name-onboarding.test.ts \
        test/account-login.test.ts test/chat-workspace-delete.test.ts \
        test/routes/company-hire-routes.test.ts test/company-native-ui.test.ts \
        test/local-model-profile.test.ts test/routes/quick-start-custom-model.test.ts \
        test/plan-auth-status.test.ts test/plan-account-management.test.ts \
        test/subscription-profile-remove.test.ts test/subscription-profiles.test.ts \
        test/cli-registry-spawn-golden.test.ts test/company-lifecycle-ui.test.ts test/company-voice-ui.test.ts \
        test/employee-pronouns.test.ts test/routes/voice-speak-routes.test.ts \
        test/hands-free.test.ts test/car-hands-free.test.ts test/voice-chat.test.ts test/car-mode.test.ts \
        test/car-mode-team-voice.test.ts test/car-mode-member-voice.test.ts test/car-reply-voice.test.ts test/car-turn-link.test.ts \
        test/routes/voice-turn-routes.test.ts test/routes/voice-service-status.test.ts test/voice-member-dispatch.test.ts test/chat-app-dm-voice.test.ts \
        test/read-aloud-team-voice.test.ts test/session-cli-builder.test.ts test/board-page-routes.test.ts test/company-logos.test.ts \
        test/reboot-restore.test.ts test/reboot-restore-persistent.test.ts \
        test/routes/reboot-restore-routes.test.ts test/codex-transcript.test.ts test/routes/company-avatar.test.ts \
        test/company-avatar-picker-ui.test.ts test/agent-avatar-background.test.ts test/company-hire-plan-refresh.test.ts \
        test/company-hire-wizard.test.ts test/company-role-context.test.ts test/company-rest-context.test.ts test/handbook.test.ts test/company-preferences-autosave.test.ts \
        test/company-settings-ui.test.ts test/chat-app-dom.test.ts test/profile-avatar-preview.test.ts test/cli-config-content.test.ts \
        test/session-runtime.test.ts test/company-runtime-ui.test.ts test/opencode-subscription-auth.test.ts \
        test/selected-claude-profile.test.ts \
        test/managed-codex-trust.test.ts test/full-access-default.test.ts test/worker-execution.test.ts test/laptop-power.test.ts test/laptop-reconnect.test.ts \
        test/expert-runtime-recipe.test.ts test/company-employee-restart.test.ts test/company-restart-ui.test.ts test/routes/session-mode-switch.test.ts \
        test/claude-plan-usage.test.ts test/claude-usage-display.test.ts test/subscription-usage.test.ts test/plan-usage-compliance.test.ts test/plan-pace.test.ts \
        test/member-menu.test.ts test/menu-viewport.test.ts test/render-index-html.test.ts test/asset-content-version.test.ts \
        test/company-plans-navigation.test.ts test/company-plans-width.test.ts \
        test/plan-move-runtime.test.ts test/plan-move-routes.test.ts test/plan-move-company.test.ts test/plan-move-launch.test.ts \
        test/agent-plan-server.test.ts test/agent-plan-request.test.ts test/plan-request.test.ts test/plan-request-capability.test.ts test/plan-request-routes.test.ts test/plan-credential-boundary.test.ts test/plan-request-ui.test.ts test/plan-request-prompt.test.ts \
        test/embassy-builtin.test.ts test/embassy-protocol-server.test.ts test/embassy-pairing-ui.test.ts \
        test/disk-stats.test.ts test/disk-stats-ui.test.ts test/routes/system-routes.test.ts test/shared-attachments.test.ts test/routes/file-routes.test.ts \
        test/chat-language-service.test.ts test/chat-plugins.test.ts test/chat-math-plugin.test.ts test/workspace-files.test.ts test/workspace-files-safety.test.ts test/workspace-publisher.test.ts \
        test/office-accounts.test.ts test/human-presence-ui.test.ts test/human-mentions-ui.test.ts test/bots-page.test.ts test/bots-ui.test.ts test/bot-avatar.test.ts test/cron-service.test.ts test/office-navigation-ui.test.ts test/workspace-files-ui.test.ts test/preview-routes.test.ts
      npm test -- test/agent-capabilities.test.ts test/chat-plugin-settings.test.ts
      npm test -- test/routes/chat-attention.test.ts test/url-session-fragment.test.ts test/company-lifecycle-fence.test.ts
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --ignore-scripts
      mkdir -p "$out/lib/reverie" "$out/bin"
      cp -r dist node_modules package.json skills scripts packages LICENSE "$out/lib/reverie/"
      # node-gyp's build metadata references the download cache; it is not needed
      # to load the compiled PTY module at runtime.
      find "$out/lib/reverie/node_modules" -path '*/node-pty/build/config.gypi' -delete
      makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/reverie" \
        --add-flags "$out/lib/reverie/dist/index.js"
      runHook postInstall
    '';
    meta = { mainProgram = "reverie"; license = lib.licenses.mit; platforms = lib.platforms.linux; };
  };
  memoryPackage = pkgs.python3Packages.buildPythonPackage {
    pname = "reverie-memory";
    version = "0.1.0";
    inherit src;
    pyproject = true;
    postUnpack = ''sourceRoot="$sourceRoot/python"'';
    build-system = [ pkgs.python3Packages.setuptools ];
    nativeCheckInputs = [ pkgs.bash pkgs.coreutils pkgs.git pkgs.nodejs_22 pkgs.tmux pkgs.jq (lib.getBin pkgs.util-linux) pkgs.python3Packages.pillow pkgs.python3Packages.aiohttp ];
    postPatch = "patchShebangs ../scripts ../docker ../.github/ci";
    checkPhase = ''
      (cd ..; PYTHONPATH="$PWD/python" PYTHONWARNINGS=ignore::ResourceWarning ${pkgs.python3.withPackages (ps: [ ps.pillow ps.aiohttp ])}/bin/python3 -m unittest discover -s tests -t .)
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
  workerExec = pkgs.writeShellScriptBin "reverie-worker-exec" ''
    exec ${memory}/bin/python3 -m reverie.worker client "$@"
  '';
  workerChild = pkgs.writeShellScriptBin "reverie-worker-child" ''
    exec ${memory}/bin/python3 -m reverie.worker child "$@"
  '';
  runtime = pkgs.buildEnv {
    name = "reverie-runtime";
    paths = [ console memory kokoro modelRelay officeRelay hands adminMemory handsTools workerExec workerChild pkgs.nodejs_22 pkgs.tmux pkgs.git pkgs.ripgrep
      pkgs.curl pkgs.coreutils pkgs.bashInteractive pkgs.gnugrep pkgs.gnused
      pkgs.gawk pkgs.findutils pkgs.gnutar pkgs.gzip pkgs.procps pkgs.which pkgs.gnumake pkgs.gcc
      pkgs.rustc pkgs.cargo pkgs.gh pkgs.jq pkgs.diffutils pkgs.fd
      pkgs.cacert lockTools ] ++ providerLaunchers;
    pathsToLink = [ "/bin" "/share" ];
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

in { inherit reverie console memory memoryPackage runtime entrypoint kokoro hands handsTools; }
