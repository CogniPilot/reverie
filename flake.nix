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
      packagesFor = system:
        let
          pkgs = pkgsFor system;
          packages = import ./nix/package.nix { inherit pkgs; src = source; };
          workerImageArtifacts = import ./nix/worker-image-artifacts.nix {
            inherit pkgs; src = source; inherit (packages) console;
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
        in packages // workerImageArtifacts // {
          default = packages.reverie;
          voiceCiVerifier = import ./nix/voice-ci-verifier.nix { inherit pkgs; src = source; };
          # Unselected native front; qualified together with its TS adapter.
          rustFront = import ./nix/rust-front.nix { inherit pkgs; src = source; };
          deployment = import ./nix/deployment.nix { inherit pkgs; src = source; };
          # Optional tools: excluded from the runtime/image and never fetched by a chat toggle.
          chatPythonLsp = pkgs.pyright;
          capabilitiesAddon = import ./nix/capabilities-addon.nix { inherit pkgs; src = source; };
          leaseCli = import ./nix/lease-cli.nix { inherit pkgs; src = source; };
          prune = import ./nix/prune.nix {
            inherit pkgs; src = source;
            leaseCli = self.packages.${system}.leaseCli;
          };
          pruneR12 = import ./nix/prune-r12.nix {
            inherit pkgs; src = source;
            leaseCli = self.packages.${system}.leaseCli;
          };
          pruneHost = import ./nix/prune-host.nix { inherit pkgs; src = source; };
          pruneDeclared = import ./nix/prune-declared.nix {
            inherit pkgs; src = source;
            prune = self.packages.${system}.pruneR12;
          };
          pruneSelftest = import ./nix/prune-selftest.nix {
            inherit pkgs; src = source;
            prune = self.packages.${system}.pruneR12;
          };
          leasePeer = import ./nix/lease-peer-static.nix { inherit pkgs; src = source; };
          leaseAcceptance = import ./nix/lease-acceptance.nix {
            inherit pkgs; src = source;
            initializer = self.packages.${system}.pruneDeclared;
            peerArtifact = self.packages.${system}.leasePeer;
          };
          cleanupObservations = import ./nix/cleanup-observations.nix { inherit pkgs; src = source; };
          adminHarnessAddon = import ./nix/admin-harness-addon.nix { inherit pkgs; src = source; };
          ownerTerminalCore = import ./nix/owner-terminal-core.nix { inherit pkgs; src = source; };
          humanTerminalToolkit = import ./nix/human-terminal-toolkit.nix { inherit pkgs; src = source; };
          # Optional diagnostic candidate only; never part of default runtime/image.
          codexObserver = import ./nix/codex-observer.nix { inherit pkgs; };
          codexObserverVendor = self.packages.${system}.codexObserver.cargoDeps;
          codexObserverNativeCheck = self.packages.${system}.codexObserver.tests.native;
          workerIdmap = import ./nix/worker-idmap.nix { inherit pkgs; };
          policyArtifacts = import ./nix/policy-artifacts.nix { inherit pkgs; src = source; };
          workerDocker = import ./nix/worker-docker-tools.nix { inherit pkgs; src = source; };
          chatModelicaLsp = import ./nix/chat-modelica-lsp.nix { inherit pkgs; };
          dockerImageWithChatLanguages = import ./nix/image.nix {
            inherit pkgs;
            src = source;
            inherit (packages) reverie console memory runtime;
            chatLanguageTools = {
              python = pkgs.pyright;
              modelica = import ./nix/chat-modelica-lsp.nix { inherit pkgs; };
            };
          };
          inherit container-memory start update;
          containerRuntime = import ./nix/container-runtime.nix { inherit pkgs; src = source; };
          launchGuard = import ./nix/launch-guard.nix { inherit pkgs; src = source; };
          dockerImage = import ./nix/image.nix {
            inherit pkgs;
            src = source;
            inherit (packages) reverie console memory runtime;
          };
          workerImage = import ./nix/image.nix {
            inherit pkgs;
            src = source;
            inherit (packages) reverie console memory runtime;
            worker = true;
          };
          workerPython = import ./nix/worker-python.nix { inherit pkgs; memory = packages.memory; };
          workerPerfImageTransport = pkgs.skopeo;
          browserRuntime = import ./nix/browser-runtime.nix { inherit pkgs; src = source; };
          workerGpuToolkit = pkgs.nvidia-container-toolkit;
          browserJobRuntime = import ./nix/browser-job-runtime.nix { inherit pkgs; src = source; };
          workerBrowserImage = import ./nix/image.nix {
            inherit pkgs;
            src = source;
            inherit (packages) reverie console memory runtime;
            worker = true;
            browserRuntime = self.packages.${system}.browserRuntime;
          };
          resourceActorImage = import ./nix/image.nix {
            inherit pkgs; src = source;
            inherit (packages) reverie console memory runtime;
            resourceReplacement = true;
          };
          resourceActorImageProvenance = import ./nix/website-image-provenance.nix {
            inherit pkgs; src = source;
            image = self.packages.${system}.resourceActorImage;
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
            image = self.packages.${system}.resourceNativeQFixtureImage;
            console = self.packages.${system}.resourceNativeQFixtureConsole;
            clientManifest = packages.workerResourceClientManifest;
          };
        };
    in {
      lib.mkContainerGpuImage = { system, capability ? "", baseImage ? self.packages.${system}.dockerImage,
        baseConfig ? baseImage.reverieConfig }:
        import ./nix/container-gpu-image.nix {
          pkgs = pkgsFor system;
          src = source;
          inherit baseImage baseConfig;
          inherit (self.packages.${system}) containerRuntime;
          gpuTelemetry = import ./nix/container-gpu-telemetry.nix {
            pkgs = pkgsFor system; src = source;
          };
          inferenceRuntime = import ./nix/local-model-runtime.nix {
            nixpkgs = toString llama-nixpkgs;
            inherit system capability;
          };
        };
      nixosModules.reveriePrune = { config, lib, pkgs, ... }: {
        imports = [
          (import ./nix/prune-service.nix {
            inherit config lib pkgs;
            pruneHostPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.pruneDeclared;
            prunePackage = self.packages.${pkgs.stdenv.hostPlatform.system}.pruneR12;
          })
          (import ./nix/prune-selftest-service.nix {
            inherit config lib pkgs;
            selftestPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.pruneSelftest;
            prunePackage = self.packages.${pkgs.stdenv.hostPlatform.system}.pruneR12;
          })
          (import ./nix/prune-lease-acceptance-service.nix {
            inherit config lib pkgs;
            leaseAcceptancePackage = self.packages.${pkgs.stdenv.hostPlatform.system}.leaseAcceptance;
          })
        ];
      };
      nixosModules.reverieCollect = { config, lib, pkgs, ... }: import ./nix/collect-service.nix {
        inherit config lib pkgs;
        observationsPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.cleanupObservations;
      };
      packages = forAllSystems packagesFor;
      lib.workerRuntimePackages = { system, runtimeSource ? source, runtimePkgs ? pkgsFor system, runChecks ? true }:
        import ./nix/worker-runtime-packages.nix {
          pkgs = runtimePkgs; src = runtimeSource; artifactSource = source; inherit runChecks;
        };
      lib.workerDockerImage = { system, uid, gid, subuidStart ? 100000, subgidStart ? 100000, subidCount ? 65536, browser ? false, runtimePackages ? packagesFor system, perfGuestCapsule ? runtimePackages.nativePerfGuestCapsule }:
        let pkgs = pkgsFor system; packages = runtimePackages;
        in assert builtins.isBool browser; import ./nix/image.nix {
          inherit pkgs runtimePackages; src = source;
          inherit (packages) reverie console memory runtime;
          worker = true;
          inherit perfGuestCapsule;
          rootlessDocker = { inherit uid gid subuidStart subgidStart subidCount; };
          browserRuntime = if browser then packages.browserRuntime else null;
        };
      lib.workerDockerImageProvenance = { system, uid, gid, subuidStart ? 100000, subgidStart ? 100000, subidCount ? 65536, browser ? false, runtimePackages ? packagesFor system, perfGuestCapsule ? runtimePackages.nativePerfGuestCapsule }:
        let
          pkgs = pkgsFor system;
          arguments = { inherit system uid gid subuidStart subgidStart subidCount browser; };
        in import ./nix/worker-image-provenance.nix {
          inherit pkgs; src = source;
          image = self.lib.workerDockerImage (arguments // { inherit perfGuestCapsule runtimePackages; });
          toolkit = runtimePackages.humanTerminalToolkit;
          workerChild = runtimePackages.workerChild;
          artifacts = runtimePackages.policyArtifacts;
          factory = { name = "lib.workerDockerImage"; } // arguments;
        };
      lib.workerChildImageAnnex = { system, baseProvenance }:
        import ./nix/worker-child-image-annex.nix {
          pkgs = pkgsFor system; src = source; inherit baseProvenance;
        };
      apps = forAllSystems (system: {
        prune = { type = "app"; program = "${self.packages.${system}.prune}/bin/reverie-prune"; meta.description = "Report eligible rebuildable output without deleting it"; };
        prune-host = { type = "app"; program = "${self.packages.${system}.pruneHost}/bin/reverie-prune-host"; meta.description = "Prepare an explicit dry-run cleanup host installation"; };
        lease = { type = "app"; program = "${self.packages.${system}.prune}/bin/lease"; meta.description = "Lease disposable work directories during active jobs"; };
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
          inherit (packages) reverie memoryPackage start update prune pruneR12 cleanupObservations ownerTerminalCore;
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

          workerChildImageAnnexContexts = assert import ./tests/worker_child_image_annex_eval.nix;
            pkgs.runCommand "reverie-worker-child-annex-context-check" { } "touch $out";
          workerPythonRuntime = import ./nix/worker-python-check.nix { inherit pkgs; python = packages.workerPython; };
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
          # Builds the helper and imports it from its immutable source; usage only, no socket or cgroup.
          pruneService = let
            evaluated = import ./tests/prune_service_eval.nix {
              inherit nixpkgs system;
              pruneHostPackage = packages.pruneDeclared;
              prunePackage = packages.pruneR12;
              legacyPrunePackage = packages.prune;
            };
          in pkgs.runCommand "reverie-prune-service-evaluation" {
            checks = builtins.toJSON evaluated.checks;
          } ''
            mkdir -p "$out"
            printf '%s\n' "$checks" > "$out/checks.json"
          '';
          pruneLeaseAcceptanceService = let
            evaluated = import ./tests/prune_lease_acceptance_eval.nix {
              inherit nixpkgs system;
              leaseAcceptancePackage = packages.leaseAcceptance;
              pruneModule = self.nixosModules.reveriePrune;
            };
          in pkgs.runCommand "reverie-prune-lease-acceptance-evaluation" {
            checks = builtins.toJSON evaluated.checks;
          } ''
            mkdir -p "$out"
            printf '%s\n' "$checks" > "$out/checks.json"
          '';
          pruneSelftestService = let
            evaluated = import ./tests/prune_selftest_eval.nix {
              inherit nixpkgs system;
              selftestPackage = packages.pruneSelftest;
              prunePackage = packages.pruneR12;
              pruneHostPackage = packages.pruneDeclared;
              pruneModule = self.nixosModules.reveriePrune;
            };
          in pkgs.runCommand "reverie-prune-selftest-evaluation" {
            checks = builtins.toJSON evaluated.checks;
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
          pillowSmoke = pkgs.runCommand "reverie-pillow-smoke" { } ''
            ${packages.memory}/bin/python3 -I - <<'PYTHON'
            from PIL import Image, ImageDraw
            im = Image.new("RGBA", (64, 64))
            ImageDraw.Draw(im).ellipse((8, 8, 56, 56), fill=(90, 60, 30, 255))
            for extension in ("png", "webp"):
                name = "smoke." + extension
                im.save(name)
                assert Image.open(name).size == (64, 64)
            PYTHON
            touch "$out"
          '';
        });
      devShells = forAllSystems (system:
        let pkgs = pkgsFor system; in {
          voice-ci = import ./nix/voice-ci.nix {
            inherit pkgs;
            kokoro = self.packages.${system}.kokoro;
            voiceVerifier = self.packages.${system}.voiceCiVerifier;
          };
          # The same Rust as CI (.github/workflows: toolchain 1.95.0), so local clippy, rustfmt and
          # tests run the toolchain CI runs. A nixpkgs update that moves it fails here, not in review.
          default = let ciRust = "1.95.0"; in assert pkgs.lib.assertMsg (pkgs.rustc.version == ciRust)
            "the reverie dev shell must carry CI's Rust ${ciRust} (found ${pkgs.rustc.version})";
            pkgs.mkShell {
            packages = [ (pkgs.python3.withPackages (ps: [ ps.pillow ps.setuptools ps.aiohttp ])) pkgs.nodejs_22 pkgs.git pkgs.tmux pkgs.gcc pkgs.gnumake pkgs.openssl pkgs.rustc pkgs.cargo pkgs.clippy pkgs.rustfmt
              # CI's test runner and same-host timing for performance changes.
              pkgs.cargo-nextest pkgs.hyperfine
              # getfattr and getfacl: deployment snapshot tests read extended attributes and ACLs.
              pkgs.gnutar pkgs.attr pkgs.acl (pkgs.lib.getBin pkgs.util-linux)
            ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.iproute2 ];
            REVERIE_FIXED_BUILD_GNUTAR = "${pkgs.gnutar}/bin/tar";
            REVERIE_FIXED_BUILD_TIMEOUT = "${pkgs.coreutils}/bin/timeout";
            REVERIE_FIXED_BUILD_GZIP_PATH = "${pkgs.gzip}/bin";
            REVERIE_TEST_CONTROLLER_PROGRAM = "${import ./nix/controller-program-test-fixture.nix { inherit pkgs; }}/bin/reverie-worker-resource-controller";
            shellHook = ''
              export PYTHONPATH="$PWD/python''${PYTHONPATH:+:$PYTHONPATH}"
              export REVERIE_LEASE_DIR="''${REVERIE_LEASE_DIR:-''${REVERIE_ROOT:-$HOME/reverie}/runtime/leases}"
              export TMPDIR="''${TMPDIR:-$HOME/scratch/reverie/tmp}"
              mkdir -p "$TMPDIR"
            '';
          };
        });
    };
}
