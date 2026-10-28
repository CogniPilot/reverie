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
          container-memory = pkgs.writeShellApplication {
            name = "container-memory";
            runtimeInputs = [ pkgs.coreutils pkgs.gawk pkgs.gnused pkgs.gnugrep ];
            text = pkgs.lib.removePrefix "#!/usr/bin/env bash\n" (builtins.readFile ./scripts/container-memory);
          };
          start = pkgs.writeShellApplication {
            name = "reverie-start";
            runtimeInputs = [ pkgs.nodejs_22 pkgs.nix pkgs.docker-client ];
            text = ''
              export REVERIE_REPO="''${REVERIE_REPO:-${source}}"
              exec node ${source}/scripts/reverie-start "$@"
            '';
          };
          update = pkgs.writeShellApplication {
            name = "reverie-update";
            runtimeInputs = [ pkgs.nix pkgs.docker-client pkgs.jq pkgs.curl pkgs.coreutils (pkgs.lib.getBin pkgs.util-linux) ];
            text = pkgs.lib.removePrefix "#!/usr/bin/env bash\n" (builtins.readFile ./scripts/reverie-update);
          };
          gpuPublisher = pkgs.writeShellApplication {
            name = "reverie-gpu-publisher";
            runtimeInputs = [ pkgs.nodejs_22 ];
            text = ''exec node --experimental-strip-types ${source}/apps/host/gpu-publisher.ts "$@"'';
          };
          localModel = pkgs.writeShellApplication {
            name = "reverie-local-model";
            runtimeInputs = [ pkgs.python3 pkgs.nix pkgs.coreutils pkgs.docker-client pkgs.systemd ];
            text = ''
              export REVERIE_MODEL_NIXPKGS=${llama-nixpkgs}
              export REVERIE_MODEL_BUILD_EXPR=${source}/nix/local-model-runtime.nix
              export REVERIE_MODEL_SYSTEM=${system}
              REVERIE_MODEL_LAUNCHER="$(readlink -f "$0")"
              export REVERIE_MODEL_LAUNCHER
              exec python3 ${source}/apps/host/local-model.py "$@"
            '';
          };
        in packages // {
          default = packages.reverie;
          # Optional tools: excluded from the runtime/image and never fetched by a chat toggle.
          chatPythonLsp = pkgs.pyright;
          capabilitiesAddon = import ./nix/capabilities-addon.nix { inherit pkgs; src = source; };
          prune = import ./nix/prune.nix { inherit pkgs; src = source; };
          pruneR12 = import ./nix/prune-r12.nix { inherit pkgs; src = source; };
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
          opsCore = import ./nix/ops-core.nix { inherit pkgs; src = source; };
          adminHarnessAddon = import ./nix/admin-harness-addon.nix { inherit pkgs; src = source; };
          ownerTerminalCore = import ./nix/owner-terminal-core.nix { inherit pkgs; src = source; };
          # Optional diagnostic candidate only; never part of default runtime/image.
          codexObserver = import ./nix/codex-observer.nix { inherit pkgs; };
          codexObserverVendor = self.packages.${system}.codexObserver.cargoDeps;
          codexObserverNativeCheck = self.packages.${system}.codexObserver.tests.native;
          workerIdmap = import ./nix/worker-idmap.nix { inherit pkgs; };
          workerDocker = import ./nix/worker-docker-tools.nix { inherit pkgs; src = source; };
          workerDockerSeccomp = import ./nix/worker-docker-profile.nix { inherit pkgs; };
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
          inherit container-memory start update gpuPublisher localModel;
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
          browserRuntime = import ./nix/browser-runtime.nix { inherit pkgs; src = source; };
          workerGpuSupport = import ./nix/worker-gpu-support.nix { inherit pkgs; src = source; };
          workerGpuToolkit = pkgs.nvidia-container-toolkit;
          browserJobRuntime = import ./nix/browser-job-runtime.nix { inherit pkgs; src = source; };
          workerBrowserImage = import ./nix/image.nix {
            inherit pkgs;
            src = source;
            inherit (packages) reverie console memory runtime;
            worker = true;
            browserRuntime = self.packages.${system}.browserRuntime;
          };
          workerBroker = pkgs.writeShellApplication {
            name = "reverie-worker-broker";
            runtimeInputs = [ pkgs.python3 pkgs.docker-client ];
            text = ''exec python3 ${source}/python/reverie/worker.py broker "$@"'';
          };
          employeeLaptopMigrate = pkgs.writeShellApplication {
            name = "reverie-employee-laptop-migrate";
            runtimeInputs = [ pkgs.python3 pkgs.docker-client pkgs.coreutils ];
            text = ''
              export PYTHONPATH=${source}/python
              exec python3 -m reverie.employee_laptop_migrate "$@"
            '';
          };
          previewProxy = pkgs.writeShellApplication {
            name = "reverie-preview-proxy";
            runtimeInputs = [ (pkgs.python3.withPackages (ps: [ ps.aiohttp ])) pkgs.docker-client ];
            text = ''exec python3 ${source}/python/reverie/preview.py "$@"'';
          };
          previewService = pkgs.writeTextDir "share/systemd/user/reverie-preview-proxy.service" ''
            [Unit]
            Description=Reverie isolated HTTPS laptop previews
            [Service]
            EnvironmentFile=%h/.config/reverie/preview-proxy.env
            ExecStart=${self.packages.${system}.previewProxy}/bin/reverie-preview-proxy --config ''${REVERIE_PREVIEW_CONFIG}
            Restart=on-failure
            RestartSec=5
            UMask=0077
            NoNewPrivileges=true
            MemoryMax=256M
            TasksMax=32
            LimitNOFILE=256
            CPUWeight=50
            TimeoutStopSec=10
            [Install]
            WantedBy=default.target
          '';
          workerNixMigrate = pkgs.writeShellApplication {
            name = "reverie-nix-store-migrate";
            runtimeInputs = [ pkgs.python3 pkgs.docker-client pkgs.coreutils ];
            text = ''
              export PYTHONPATH=${source}/python
              exec python3 -m reverie.worker_nix_migrate "$@"
            '';
          };
          workerServiceCheck = pkgs.writeShellApplication {
            name = "reverie-worker-service-check";
            runtimeInputs = [ pkgs.python3 pkgs.docker-client ];
            text = ''
              export PYTHONPATH=${source}/python
              exec python3 -m reverie.worker_service "$@" check-backend
            '';
          };
          workerService = pkgs.writeTextDir "share/systemd/user/reverie-worker-broker.service" ''
            [Unit]
            Description=Reverie laptop broker and office watchdog
            [Service]
            EnvironmentFile=%h/.config/reverie/worker-broker.env
            ExecStartPre=${self.packages.${system}.workerServiceCheck}/bin/reverie-worker-service-check --config ''${REVERIE_WORKER_CONFIG}
            ExecStart=${self.packages.${system}.workerBroker}/bin/reverie-worker-broker --config ''${REVERIE_WORKER_CONFIG}
            Restart=on-failure
            RestartSec=3
            TimeoutStopSec=35
            KillMode=mixed
            UMask=0077
            NoNewPrivileges=true
            MemoryMax=512M
            TasksMax=512
            [Install]
            WantedBy=default.target
          '';
          workerServiceSetup = pkgs.writeShellApplication {
            name = "reverie-worker-service";
            runtimeInputs = [ (pkgs.python3.withPackages (ps: [ ps.pyyaml ])) pkgs.docker-client pkgs.systemd pkgs.nix ];
            text = ''
              export PYTHONPATH=${source}/python
              export REVERIE_WORKER_SERVICE_UNIT=${self.packages.${system}.workerService}/share/systemd/user/reverie-worker-broker.service
              exec python3 -m reverie.worker_service "$@"
            '';
          };
          isolate = pkgs.writeShellApplication {
            name = "reverie-isolate";
            runtimeInputs = [ pkgs.python3 pkgs.nix pkgs.docker-client pkgs.systemd pkgs.gnutar ];
            text = ''
              export REVERIE_REPO="''${REVERIE_REPO:-${source}}"
              exec python3 ${source}/apps/host/isolate.py "$@"
            '';
          };
        };
    in {
      nixosModules.workerIsolation = { config, lib, pkgs, ... }: import ./nix/worker-isolation.nix {
        inherit config lib pkgs;
        brokerPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.workerBroker;
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
        ];
      };
      nixosModules.reverieCollect = { config, lib, pkgs, ... }: import ./nix/collect-service.nix {
        inherit config lib pkgs;
        observationsPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.cleanupObservations;
      };
      packages = forAllSystems packagesFor;
      lib.workerDockerImage = { system, uid, gid, subuidStart ? 100000, subgidStart ? 100000, subidCount ? 65536, browser ? false }:
        let pkgs = pkgsFor system; packages = packagesFor system;
        in assert builtins.isBool browser; import ./nix/image.nix {
          inherit pkgs; src = source;
          inherit (packages) reverie console memory runtime;
          worker = true;
          rootlessDocker = { inherit uid gid subuidStart subgidStart subidCount; };
          browserRuntime = if browser then packages.browserRuntime else null;
        };
      apps = forAllSystems (system: {
        prune = { type = "app"; program = "${self.packages.${system}.prune}/bin/reverie-prune"; meta.description = "Report eligible rebuildable output without deleting it"; };
        prune-host = { type = "app"; program = "${self.packages.${system}.pruneHost}/bin/reverie-prune-host"; meta.description = "Prepare an explicit dry-run cleanup host installation"; };
        lease = { type = "app"; program = "${self.packages.${system}.prune}/bin/lease"; meta.description = "Lease disposable work directories during active jobs"; };
        worker-service = { type = "app"; program = "${self.packages.${system}.workerServiceSetup}/bin/reverie-worker-service"; meta.description = "Install/control the existing owner user laptop broker without host OS configuration"; };
        worker-gpu = { type = "app"; program = "${self.packages.${system}.workerGpuSupport}/bin/reverie-worker-gpu"; meta.description = "Read-only selected employee GPU/CDI/image preflight; no setup or laptop effects"; };
        ops-service = { type = "app"; program = "${self.packages.${system}.opsCore}/bin/reverie-ops-service"; meta.description = "Install/control the private authenticated OPS executor; no grants or automatic effects"; };
        launch-guard = { type = "app"; program = "${self.packages.${system}.launchGuard}/bin/reverie-launch-guard"; meta.description = "Evaluate metadata-only launch guard fixtures without live effects"; };
        default = { type = "app"; program = "${self.packages.${system}.reverie}/bin/reverie"; meta.description = "Reverie agent console"; };
        container-memory = { type = "app"; program = "${self.packages.${system}.container-memory}/bin/container-memory"; meta.description = "Manage Reverie container memory"; };
        start = { type = "app"; program = "${self.packages.${system}.start}/bin/reverie-start"; meta.description = "Start the Nix-built Docker image with a contained first-run layout"; };
        update = { type = "app"; program = "${self.packages.${system}.update}/bin/reverie-update"; meta.description = "Rebuild and replace an existing Docker deployment"; };
        kokoro = { type = "app"; program = "${self.packages.${system}.kokoro}/bin/reverie-kokoro"; meta.description = "Local Kokoro speech service with persistent models"; };
        local-model = { type = "app"; program = "${self.packages.${system}.localModel}/bin/reverie-local-model"; meta.description = "Run GGUF models on a host NVIDIA GPU or CPU"; };
        isolate = { type = "app"; program = "${self.packages.${system}.isolate}/bin/reverie-isolate"; meta.description = "Prepare and activate host-managed agent containers"; };
        collect = { type = "app"; program = "${self.packages.${system}.cleanupObservations}/bin/reverie-observations"; meta.description = "Explicit opt-in user resource observations; no cleanup authority"; };
        preview-proxy = { type = "app"; program = "${self.packages.${system}.previewProxy}/bin/reverie-preview-proxy"; meta.description = "Serve isolated HTTPS previews of opted-in laptop ports"; };
        worker-nix-migrate = { type = "app"; program = "${self.packages.${system}.workerNixMigrate}/bin/reverie-nix-store-migrate"; meta.description = "Inventory and explicitly migrate one stopped laptop Nix store"; };
        employee-laptop-migrate = { type = "app"; program = "${self.packages.${system}.employeeLaptopMigrate}/bin/reverie-employee-laptop-migrate"; meta.description = "Publish stopped paired home and Nix data by permanent employee identity"; };
      });
      checks = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          packages = self.packages.${system};
        in {
          inherit (packages) reverie memoryPackage start update gpuPublisher previewProxy previewService prune pruneR12 cleanupObservations ownerTerminalCore;
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
          pruneService = let
            evaluated = import ./tests/prune_service_eval.nix {
              inherit nixpkgs system;
              pruneHostPackage = packages.pruneDeclared;
              prunePackage = packages.pruneR12;
            };
          in pkgs.runCommand "reverie-prune-service-evaluation" {
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
          voice-ci = import ./nix/voice-ci.nix { inherit pkgs; kokoro = self.packages.${system}.kokoro; };
          default = pkgs.mkShell {
            packages = [ (pkgs.python3.withPackages (ps: [ ps.pillow ps.setuptools ps.aiohttp ])) pkgs.nodejs_22 pkgs.git pkgs.tmux pkgs.gcc pkgs.gnumake pkgs.openssl ];
            shellHook = ''
              export PYTHONPATH="$PWD/python''${PYTHONPATH:+:$PYTHONPATH}"
              export TMPDIR="''${TMPDIR:-$HOME/scratch/reverie/tmp}"
              mkdir -p "$TMPDIR"
            '';
          };
        });
    };
}
