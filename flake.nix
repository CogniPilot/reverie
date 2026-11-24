{
  description = "Reverie: persistent agents, console and reproducible runtime image";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  inputs.llama-nixpkgs.url = "github:NixOS/nixpkgs/02f5696b0e6097e589076d886b317b83ff0437d7";
  outputs = { self, nixpkgs, llama-nixpkgs }:
    let
      source = import ./nix/source-filter.nix { lib = nixpkgs.lib; src = ./.; };
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import nixpkgs {
        inherit system;
      };
      # The default set runs every test suite inside its artefact build.
      packagesFor = system: packageSetFor system true;
      # One evaluation per system and variant; lib functions select by the same knob.
      selectPackages = system: runChecks: assert builtins.isBool runChecks;
        if runChecks then self.packages.${system} else self.legacyPackages.${system}.unchecked;
      # runChecks is the single knob; nix/build-policy.nix owns what it changes.
      # Every first-party recipe receives its package set through this function.
      recipePkgsFor = system: runChecks:
        import ./nix/build-policy.nix { pkgs = pkgsFor system; inherit runChecks; };
      packageSetFor = system: runChecks:
        let
          pkgs = recipePkgsFor system runChecks;
          packages = import ./nix/package.nix { inherit pkgs; src = source; };
          workerImageArtifacts = import ./nix/native-worker-packages.nix {
            inherit pkgs; src = source;
          };
          container-memory = pkgs.writeShellApplication {
            name = "container-memory";
            runtimeInputs = [ pkgs.coreutils pkgs.gawk pkgs.gnused pkgs.gnugrep ];
            text = pkgs.lib.removePrefix "#!/usr/bin/env bash\n" (builtins.readFile ./scripts/container-memory);
          };
          start = pkgs.writeShellApplication {
            name = "reverie-start";
            runtimeInputs = [ pkgs.nodejs_22 pkgs.nix pkgs.docker-client (pkgs.lib.getBin pkgs.util-linux) ];
            text = ''
              export REVERIE_REPO="''${REVERIE_REPO:-${source}}"
              exec node ${source}/scripts/reverie-start "$@"
            '';
          };
          update = pkgs.writeShellApplication {
            name = "reverie-update";
            runtimeInputs = [ pkgs.nodejs_22 pkgs.nix pkgs.docker-client pkgs.jq pkgs.curl pkgs.coreutils (pkgs.lib.getBin pkgs.util-linux) ];
            text = pkgs.lib.removePrefix "#!/usr/bin/env bash\n" (builtins.readFile ./scripts/reverie-update);
          };
          # Members refer to their own variant, never to the default set.
          set = packages // workerImageArtifacts // {
          default = packages.reverie;
          workerClientCapsule = import ./nix/worker-client-capsule.nix {
            inherit pkgs;
            src = source;
          };
          docker-memory-high-helper = import ./nix/docker-resource-helper.nix { inherit pkgs; src = source; };
          docker-memory-high-helper-image = import ./nix/docker-memory-high-helper-image.nix { inherit pkgs; src = source; };
          docker-pool-restore-helper-image = import ./nix/docker-pool-restore-helper-image.nix { inherit pkgs; src = source; };
          docker-recovery-helper-image = import ./nix/docker-resource-helper-image.nix {
            inherit pkgs;
            helper = set.docker-memory-high-helper;
            name = "reverie-boxed-recovery-helper";
          };
          # Baseline labels, so a leaf writer container created from it has the fixed
          # configuration. Selected only by the separate leafWriterHelperImageId pin.
          docker-leaf-writer-helper-image = import ./nix/docker-resource-helper-image.nix {
            inherit pkgs;
            helper = set.docker-memory-high-helper;
            name = "reverie-boxed-leaf-writer-helper";
          };
          voiceCiVerifier = import ./nix/voice-ci-verifier.nix { inherit pkgs; src = source; };
          recoveryLedger = import ./nix/recovery-ledger.nix { inherit pkgs; src = source; };
          imageCheck = import ./nix/image-check.nix { inherit pkgs; src = source; };
          # Unselected native front; qualified together with its TS adapter.
          rustFront = import ./nix/rust-front.nix { inherit pkgs; src = source; };
          deployment = import ./nix/deployment.nix { inherit pkgs; src = source; };
          # Optional tools: excluded from the runtime/image and never fetched by a chat toggle.
          chatPythonLsp = pkgs.pyright;
          capabilitiesAddon = import ./nix/capabilities-addon.nix { inherit pkgs; src = source; };
          leaseCli = import ./nix/lease-cli.nix { inherit pkgs; src = source; };
          leasePeer = import ./nix/lease-peer-static.nix { inherit pkgs; src = source; };
          cleanupObservations = import ./nix/cleanup-observations.nix { inherit pkgs; src = source; };
          adminHarnessAddon = import ./nix/admin-harness-addon.nix {
            inherit pkgs;
            inherit (packages) hands handsTools;
          };
          humanTerminalToolkit = import ./nix/human-terminal-toolkit.nix { inherit pkgs; src = source; };
          # Optional diagnostic candidate only; never part of default runtime/image.
          codexObserver = import ./nix/codex-observer.nix { inherit pkgs; };
          codexObserverVendor = set.codexObserver.cargoDeps;
          codexObserverNativeCheck = set.codexObserver.tests.native;
          workerIdmap = import ./nix/worker-idmap.nix { inherit pkgs; };
          policyArtifacts = import ./nix/policy-artifacts.nix { inherit pkgs; src = source; };
          workerDocker = import ./nix/worker-docker-tools.nix { inherit pkgs; src = source; };
          chatModelicaLsp = import ./nix/chat-modelica-lsp.nix { inherit pkgs; };
          dockerImageWithChatLanguages = import ./nix/image.nix {
            inherit pkgs;
            src = source;
            inherit (packages) reverie console runtime entrypoint;
            chatLanguageTools = {
              python = pkgs.pyright;
              modelica = import ./nix/chat-modelica-lsp.nix { inherit pkgs; };
            };
          };
          inherit container-memory start update;
          launchGuard = import ./nix/launch-guard.nix { inherit pkgs; src = source; };
          dockerImage = import ./nix/image.nix {
            inherit pkgs;
            src = source;
            inherit (packages) reverie console runtime entrypoint;
          };
          workerImage = import ./nix/image.nix {
            inherit pkgs;
            src = source;
            inherit (packages) reverie console runtime entrypoint;
            worker = true;
          };
          workerPerfImageTransport = pkgs.skopeo;
          browserRuntime = import ./nix/browser-runtime.nix { inherit pkgs; src = source; };
          workerGpuToolkit = pkgs.nvidia-container-toolkit;
          browserJobRuntime = import ./nix/browser-job-runtime.nix { inherit pkgs; src = source; };
          workerBrowserImage = import ./nix/image.nix {
            inherit pkgs;
            src = source;
            inherit (packages) reverie console runtime entrypoint;
            worker = true;
            browserRuntime = set.browserRuntime;
          };
          resourceActorImage = import ./nix/image.nix {
            inherit pkgs; src = source;
            inherit (packages) reverie console runtime entrypoint;
            resourceReplacement = true;
          };
          resourceActorImageProvenance = import ./nix/website-image-provenance.nix {
            inherit pkgs; src = source;
            image = set.resourceActorImage;
            console = packages.console;
            clientManifest = packages.workerResourceClientManifest;
          };
          resourceNativeQFixtureConsole = (import ./nix/resource-native-q-fixture.nix {
            inherit pkgs; src = source; console = packages.console; client = packages.workerNativeClient;
          }).console;
          resourceNativeQFixtureImage = (import ./nix/resource-native-q-fixture.nix {
            inherit pkgs; src = source; console = packages.console; client = packages.workerNativeClient;
          }).image;
          resourceNativeQFixtureProvenance = import ./nix/website-image-provenance.nix {
            inherit pkgs; src = source;
            image = set.resourceNativeQFixtureImage;
            console = set.resourceNativeQFixtureConsole;
            clientManifest = packages.workerResourceClientManifest;
          };
        };
        in set;
    in {
      # runChecks = false selects the same recipes without their test phases
      # (nix/build-policy.nix). It chooses the defaults below; an argument the
      # caller passes explicitly, such as baseImage, keeps the variant it was built with.
      lib.mkBoxedWebsiteImage = { system, runtimeConfiguration, runChecks ? true,
        baseImage ? (selectPackages system runChecks).dockerImage, baseConfig ? baseImage.reverieConfig,
        privateAccessRuntime ? null, clientCapsule ? (selectPackages system runChecks).workerClientCapsule }:
        import ./nix/boxed-website-image.nix {
          pkgs = recipePkgsFor system runChecks;
          inherit baseImage baseConfig runtimeConfiguration privateAccessRuntime clientCapsule;
          gpuProjectionCompiler = (selectPackages system runChecks).containerRuntime;
        };
      lib.mkContainerGpuImage = { system, capability ? "", runChecks ? true,
        baseImage ? (selectPackages system runChecks).dockerImage,
        baseConfig ? baseImage.reverieConfig }:
        import ./nix/container-gpu-image.nix {
          pkgs = recipePkgsFor system runChecks;
          src = source;
          inherit baseImage baseConfig;
          inherit (selectPackages system runChecks) containerRuntime entrypoint;
          inferenceRuntime = import ./nix/local-model-runtime.nix {
            nixpkgs = toString llama-nixpkgs;
            inherit system capability;
          };
        };
      nixosModules.reverieCollect = { config, lib, pkgs, ... }: import ./nix/collect-service.nix {
        inherit config lib pkgs;
        observationsPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.cleanupObservations;
      };
      packages = forAllSystems packagesFor;
      # Every package above without its test phase, for example `.#unchecked.workerImage`.
      # Their suites are checks.deployPathSuites, built from the default set.
      legacyPackages = forAllSystems (system: { unchecked = packageSetFor system false; });
      lib.workerRuntimePackages = { system, runtimeSource ? source, runtimePkgs ? pkgsFor system, runChecks ? true }:
        import ./nix/worker-runtime-packages.nix {
          pkgs = runtimePkgs; src = runtimeSource; artifactSource = source; inherit runChecks;
        };
      lib.workerDockerImage = { system, uid, gid, subuidStart ? 100000, subgidStart ? 100000, subidCount ? 65536, browser ? false, runChecks ? true, runtimePackages ? selectPackages system runChecks, perfGuestCapsule ? runtimePackages.nativePerfGuestCapsule }:
        let pkgs = recipePkgsFor system runChecks; packages = runtimePackages;
        in assert builtins.isBool browser; import ./nix/image.nix {
          inherit pkgs runtimePackages; src = source;
          inherit (packages) reverie console runtime;
          entrypoint = (selectPackages system runChecks).entrypoint;
          worker = true;
          inherit perfGuestCapsule;
          rootlessDocker = { inherit uid gid subuidStart subgidStart subidCount; };
          browserRuntime = if browser then packages.browserRuntime else null;
        };
      # The factory record has a fixed shape and names neither runtimePackages nor
      # runChecks; the facts bind the archive bytes of whichever variant was built.
      lib.workerDockerImageProvenance = { system, uid, gid, subuidStart ? 100000, subgidStart ? 100000, subidCount ? 65536, browser ? false, runChecks ? true, runtimePackages ? selectPackages system runChecks, perfGuestCapsule ? runtimePackages.nativePerfGuestCapsule }:
        let
          pkgs = recipePkgsFor system runChecks;
          arguments = { inherit system uid gid subuidStart subgidStart subidCount browser; };
        in import ./nix/worker-image-provenance.nix {
          inherit pkgs; src = source;
          image = self.lib.workerDockerImage (arguments // { inherit perfGuestCapsule runtimePackages runChecks; });
          toolkit = runtimePackages.humanTerminalToolkit;
          workerChild = runtimePackages.workerChild;
          artifacts = runtimePackages.policyArtifacts;
          factory = { name = "lib.workerDockerImage"; } // arguments;
        };
      lib.workerChildImageAnnex = { system, baseProvenance, runChecks ? true }:
        import ./nix/worker-child-image-annex.nix {
          pkgs = recipePkgsFor system runChecks; src = source; inherit baseProvenance;
        };
      apps = forAllSystems (system: {
        lease = { type = "app"; program = "${self.packages.${system}.leaseCli}/bin/reverie-lease"; meta.description = "Lease disposable work directories during active jobs"; };
        launch-guard = { type = "app"; program = "${self.packages.${system}.launchGuard}/bin/reverie-launch-guard"; meta.description = "Evaluate metadata-only launch guard fixtures without live effects"; };
        default = { type = "app"; program = "${self.packages.${system}.reverie}/bin/reverie"; meta.description = "Reverie agent console"; };
        container-memory = { type = "app"; program = "${self.packages.${system}.container-memory}/bin/container-memory"; meta.description = "Manage Reverie container memory"; };
        start = { type = "app"; program = "${self.packages.${system}.start}/bin/reverie-start"; meta.description = "Start the Nix-built Docker image with optional --scratch DIR; --force recreates a stopped ordinary website container"; };
        update = { type = "app"; program = "${self.packages.${system}.update}/bin/reverie-update"; meta.description = "Rebuild and replace an existing Docker deployment"; };
        kokoro = { type = "app"; program = "${self.packages.${system}.kokoro}/bin/reverie-kokoro"; meta.description = "Local Kokoro speech service with persistent models"; };
        collect = { type = "app"; program = "${self.packages.${system}.cleanupObservations}/bin/reverie-observations"; meta.description = "Explicit opt-in user resource observations; no cleanup authority"; };
      });
      checks = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          packages = self.packages.${system};
        in {
          inherit (packages) reverie start update cleanupObservations;
          inherit (packages.console) workerWebFixtures;
          # The suites an unchecked deploy-path build skips, from the default set and
          # in the same build sandbox. Each entry is its own derivation, so
          # `nix build .#checks.SYSTEM.deployPathSuites --keep-going` runs them
          # side by side and names every one that fails. No image archive is assembled.
          deployPathSuites = pkgs.linkFarm "reverie-deploy-path-suites" (pkgs.lib.mapAttrsToList
            (name: path: { inherit name path; }) {
              inherit (packages) reverie console runtime containerRuntime entrypoint
                backendNativeCli workerExec leaseCli handsTools rustFront rustRouteHandler recoveryLedger
                laptopTools policyArtifacts humanTerminalToolkit workerNativeNixStorePrepare workerChild
                nativePerfGuestCapsule workerClientCapsule docker-memory-high-helper deployment;
              inherit (packages.runtime) voiceService;
            });
          # Legacy attach transport remains a component-only CI fixture.
          # It is not an installable public package, app or host module.
          nativeViewerFixtureImage = import ./nix/worker-viewer-image.nix {
            inherit pkgs;
            broker = import ./nix/native-worker-broker.nix { inherit pkgs; src = source; };
          };
          boxedRuntimeBoundary = let
            actual = {
              packages = builtins.attrNames self.packages.${system};
              apps = builtins.attrNames self.apps.${system};
              nixosModules = builtins.attrNames self.nixosModules;
              lib = builtins.attrNames self.lib;
            };
            checked = import ./nix/boxed-runtime-boundary.nix { inherit actual; source = ./.; };
            mutations = import ./tests/boxed_runtime_boundary_eval.nix;
          in assert checked.passed; pkgs.writeText "reverie-boxed-runtime-boundary.json"
            (builtins.toJSON { inherit (checked) checks; inherit mutations; });
          boxedWebsiteImage = pkgs.writeText "reverie-boxed-website-image-checks.json"
            (builtins.toJSON (import ./tests/boxed_website_image_eval.nix));

          workerChildImageAnnexContexts = assert import ./tests/worker_child_image_annex_eval.nix;
            pkgs.runCommand "reverie-worker-child-annex-context-check" { } "touch $out";
          workerPerfTools = let perf = import ./nix/worker-perf.nix { inherit pkgs; };
            in assert builtins.elem perf (import ./nix/worker-base-tools.nix { inherit pkgs; });
              pkgs.runCommand "reverie-worker-perf-tool-check" { } ''
                ${perf}/bin/perf version --build-options > "$out"
                grep -Ei 'python:.*\[ *off *\]' "$out"
                test ! -e ${perf}/libexec/perf-core/scripts/python
              '';
          codexObserverSource = packages.codexObserver.tests.source;
          codexObserverVendor = packages.codexObserver.tests.vendor;
          collectService = pkgs.runCommand "reverie-collect-service-evaluation" {
            checks = builtins.toJSON (import ./tests/collect_service_eval.nix {
              inherit nixpkgs system;
              observationsPackage = packages.cleanupObservations;
            });
          } ''
            mkdir -p "$out"
            printf '%s\n' "$checks" > "$out/checks.json"
          '';
          sourceFilter = pkgs.runCommand "reverie-source-filter-policy" {
            checks = builtins.toJSON (import ./tests/source_filter_eval.nix { lib = nixpkgs.lib; });
          } ''
            mkdir -p "$out"
            printf '%s\n' "$checks" > "$out/checks.json"
          '';
          nativeSmoke = pkgs.runCommand "reverie-native-smoke" { } ''
            export HOME="$TMPDIR/home"
            export REVERIE_INSTALL_CLIS=none
            mkdir -p "$HOME"
            ${packages.reverie}/bin/reverie --version
            ${pkgs.nodejs_22}/bin/node <<'JAVASCRIPT'
            const pty = require("${packages.console}/lib/reverie/node_modules/node-pty");
            const child = pty.spawn("${pkgs.bash}/bin/bash", ["-c", "printf reverie-pty-ok"], { env: process.env });
            let output = "";
            const timeout = setTimeout(() => process.exit(1), 5000);
            child.onData(data => output += data);
            child.onExit(({exitCode}) => {
              clearTimeout(timeout);
              if (exitCode !== 0 || !output.includes("reverie-pty-ok")) process.exit(1);
            });
            JAVASCRIPT
            ${packages.runtime}/bin/tmux -S "$TMPDIR/tmux.sock" -f /dev/null new-session -d -s smoke '${pkgs.coreutils}/bin/sleep 10'
            ${packages.runtime}/bin/tmux -S "$TMPDIR/tmux.sock" kill-server
            ${packages.reverie}/bin/reverie web --host 127.0.0.1 --port 3100 > console.log 2>&1 &
            server=$!
            trap 'kill "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true' EXIT
            ready=0
            for attempt in $(seq 1 30); do
              code=$(${pkgs.curl}/bin/curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3100/api/status || true)
              if [ "$code" = 401 ]; then ready=1; break; fi
              kill -0 "$server" || { cat console.log; exit 1; }
              sleep 1
            done
            test "$ready" = 1 || { cat console.log; exit 1; }
            test -s "$HOME/reverie/companies/default/data/owner-password"
            ${packages.reverie}/bin/reverie owner bootstrap --username owner --enforce > owner-first-login.txt
            ${packages.reverie}/bin/reverie owner status | ${pkgs.jq}/bin/jq -e '.configured and .username == "owner" and .mustChange'
            touch "$out"
          '';
        });
      devShells = forAllSystems (system:
        let pkgs = pkgsFor system; in {
          voice-ci = import ./nix/voice-ci.nix {
            inherit pkgs;
            kokoro = self.packages.${system}.kokoro;
            voiceVerifier = self.packages.${system}.voiceCiVerifier;
            laptopTools = self.packages.${system}.laptopTools;
          };
          # The same Rust as CI (.github/workflows: toolchain 1.95.0), so local clippy, rustfmt and
          # tests run the toolchain CI runs. A nixpkgs update that moves it fails here, not in review.
          default = let ciRust = "1.95.0"; in assert pkgs.lib.assertMsg (pkgs.rustc.version == ciRust)
            "the reverie dev shell must carry CI's Rust ${ciRust} (found ${pkgs.rustc.version})";
            pkgs.mkShell {
            packages = [ pkgs.nodejs_22 pkgs.git pkgs.tmux pkgs.gcc pkgs.gnumake pkgs.curl pkgs.openssl pkgs.rustc pkgs.cargo pkgs.clippy pkgs.rustfmt
              # npm uses node-gyp to build the third-party node-pty addon.
              pkgs.python3
              # CI's test runner and same-host timing for performance changes.
              pkgs.cargo-nextest pkgs.hyperfine
              # getfattr and getfacl: deployment snapshot tests read extended attributes and ACLs.
              pkgs.gnutar pkgs.attr pkgs.acl pkgs.which pkgs.bash (pkgs.lib.getBin pkgs.util-linux)
            ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.iproute2 pkgs.bubblewrap ];
            SHELL = "${pkgs.bash}/bin/bash";
            npm_config_nodedir = "${pkgs.nodejs_22}";
            LOCALE_ARCHIVE = pkgs.lib.optionalString pkgs.stdenv.isLinux "${pkgs.glibcLocales}/lib/locale/locale-archive";
            REVERIE_FIXED_BUILD_GNUTAR = "${pkgs.gnutar}/bin/tar";
            REVERIE_FIXED_BUILD_TIMEOUT = "${pkgs.coreutils}/bin/timeout";
            REVERIE_FIXED_BUILD_GZIP_PATH = "${pkgs.gzip}/bin";
            REVERIE_TEST_CONTROLLER_PROGRAM = "${import ./nix/controller-program-test-fixture.nix { inherit pkgs; }}/bin/reverie-worker-resource-controller";
            shellHook = ''
              export REVERIE_LEASE_DIR="''${REVERIE_LEASE_DIR:-''${REVERIE_ROOT:-$HOME/reverie}/runtime/leases}"
              export TMPDIR="''${TMPDIR:-$HOME/scratch/reverie/tmp}"
              mkdir -p "$TMPDIR"
            '';
          };
        });
    };
}
