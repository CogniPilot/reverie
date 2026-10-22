{
  description = "Reverie: persistent agents, console and reproducible runtime image";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  inputs.llama-nixpkgs.url = "github:NixOS/nixpkgs/02f5696b0e6097e589076d886b317b83ff0437d7";
  outputs = { self, nixpkgs, llama-nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import nixpkgs {
        inherit system;
      };
      packagesFor = system:
        let
          pkgs = pkgsFor system;
          packages = import ./nix/package.nix { inherit pkgs; src = self; };
          container-memory = pkgs.writeShellApplication {
            name = "container-memory";
            runtimeInputs = [ pkgs.coreutils pkgs.gawk pkgs.gnused pkgs.gnugrep ];
            text = pkgs.lib.removePrefix "#!/usr/bin/env bash\n" (builtins.readFile ./scripts/container-memory);
          };
          start = pkgs.writeShellApplication {
            name = "reverie-start";
            runtimeInputs = [ pkgs.nodejs_22 pkgs.nix pkgs.docker-client ];
            text = ''
              export REVERIE_REPO="''${REVERIE_REPO:-${self}}"
              exec node ${self}/scripts/reverie-start "$@"
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
            text = ''exec node --experimental-strip-types ${self}/apps/host/gpu-publisher.ts "$@"'';
          };
          localModel = pkgs.writeShellApplication {
            name = "reverie-local-model";
            runtimeInputs = [ pkgs.python3 pkgs.nix pkgs.coreutils pkgs.docker-client pkgs.systemd ];
            text = ''
              export REVERIE_MODEL_NIXPKGS=${llama-nixpkgs}
              export REVERIE_MODEL_BUILD_EXPR=${self}/nix/local-model-runtime.nix
              export REVERIE_MODEL_SYSTEM=${system}
              export REVERIE_MODEL_LAUNCHER="$(readlink -f "$0")"
              exec python3 ${self}/apps/host/local-model.py "$@"
            '';
          };
        in packages // {
          default = packages.reverie;
          inherit container-memory start update gpuPublisher localModel;
          dockerImage = import ./nix/image.nix {
            inherit pkgs;
            src = self;
            inherit (packages) reverie console memory runtime;
          };
        };
    in {
      packages = forAllSystems packagesFor;
      apps = forAllSystems (system: {
        default = { type = "app"; program = "${self.packages.${system}.reverie}/bin/reverie"; meta.description = "Reverie agent console"; };
        container-memory = { type = "app"; program = "${self.packages.${system}.container-memory}/bin/container-memory"; meta.description = "Manage Reverie container memory"; };
        start = { type = "app"; program = "${self.packages.${system}.start}/bin/reverie-start"; meta.description = "Start the Nix-built Docker image with a contained first-run layout"; };
        update = { type = "app"; program = "${self.packages.${system}.update}/bin/reverie-update"; meta.description = "Rebuild and replace an existing Docker deployment"; };
        kokoro = { type = "app"; program = "${self.packages.${system}.kokoro}/bin/reverie-kokoro"; meta.description = "Local Kokoro speech service with persistent models"; };
        local-model = { type = "app"; program = "${self.packages.${system}.localModel}/bin/reverie-local-model"; meta.description = "Run GGUF models on a host NVIDIA GPU or CPU"; };
      });
      checks = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          packages = self.packages.${system};
        in {
          inherit (packages) reverie memoryPackage start update gpuPublisher;
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
          default = pkgs.mkShell {
            packages = [ (pkgs.python3.withPackages (ps: [ ps.pillow ps.setuptools ])) pkgs.nodejs_22 pkgs.git pkgs.tmux pkgs.gcc pkgs.gnumake ];
            shellHook = ''
              export PYTHONPATH="$PWD/python''${PYTHONPATH:+:$PYTHONPATH}"
              export TMPDIR="''${TMPDIR:-$HOME/scratch/reverie/tmp}"
              mkdir -p "$TMPDIR"
            '';
          };
        });
    };
}
