{
  description = "Reverie / Codeman — persistent agent workspace";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # ─────────────────────────────────────────────────────────────────────
        # PINNED AGENT CLI VERSIONS — single source of truth.
        # Bump deliberately in a release. The self-updater's environment gate
        # detects drift between these pins and the running image.
        # ─────────────────────────────────────────────────────────────────────
        cliPins = {
          claude-code = "2.1.258";
          gemini-cli = "0.58.0";
          codex = "0.152.1";
          opencode = "1.18.26";
          pnpm = "12.6.0";
        };

        # Runtime user (matches docker-compose.yaml defaults).
        runtimeUser = "codeman";
        puid = 1000;
        pgid = 1000;

        # ─────────────────────────────────────────────────────────────────────
        # SYSTEM PACKAGES — mirrors the apt-get install in server.Dockerfile.
        # python3/make/g++ are for the SELF-UPDATER (node-pty has no Linux
        # prebuild; a release that bumps it compiles from source in-container).
        # ─────────────────────────────────────────────────────────────────────
        runtimeDeps = with pkgs; [
          nodejs_22
          tmux
          git
          ripgrep
          procps
          openssh
          curl
          ca-certificates
          g++
          make
          python3
          # libsecret-1-0: keyring access for CLIs that store tokens.
          (pkgs.libsecret)
        ];

        # Development additions (not in the production image).
        devDeps = with pkgs; [
          nodePackages.typescript
          nodePackages.esbuild
          nodePackages.vitest
          nodePackages.tsx
          nodePackages.prettier
          nodePackages.eslint
          jq
          fd
          ripgrep
        ];

        # ─────────────────────────────────────────────────────────────────────
        # APP BUILD — runs `npm ci && npm run build` in a Nix derivation.
        # devDependencies are KEPT (the in-app self-updater rebuilds in-place).
        # ─────────────────────────────────────────────────────────────────────
        appBuild = pkgs.stdenvNoCC.mkDerivation {
          pname = "codeman-app";
          version = "1.41.1";
          src = self;

          nativeBuildInputs = [
            pkgs.nodejs_22
            pkgs.python3
            pkgs.make
            pkgs.gcc
          ];

          dontConfigure = true;

          buildPhase = ''
            export npm_config_prefix="$out"
            npm ci
            npm run build
          '';

          installPhase = ''
            mkdir -p $out/opt/codeman
            cp -r dist node_modules package.json package-lock.json \
                  scripts skills src config plugins .claude-plugin \
                  $out/opt/codeman/ 2>/dev/null || true
            # Copy only what exists (some dirs are optional).
            for d in skills plugins .claude-plugin config; do
              [ -d "$d" ] && cp -r "$d" $out/opt/codeman/
            done
          '';

          # node-pty compiles from source (no prebuild for Linux).
          NPM_CONFIG_BUILD_FROM_SOURCE = "true";
        };

        # ─────────────────────────────────────────────────────────────────────
        # AGENT CLIs — installed into a dedicated prefix (/opt/codeman-cli)
        # so a session can self-update in place without touching /usr/local.
        # ─────────────────────────────────────────────────────────────────────
        cliBundle = pkgs.stdenvNoCC.mkDerivation {
          pname = "codeman-clis";
          version = "pinned";

          nativeBuildInputs = [ pkgs.nodejs_22 ];

          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            export npm_config_prefix="$out"
            npm install --global \
              @anthropic-ai/claude-code@${cliPins.claude-code} \
              @google/gemini-cli@${cliPins.gemini-cli} \
              @openai/codex@${cliPins.codex} \
              opencode-ai@${cliPins.opencode} \
              pnpm@${cliPins.pnpm}
            npm cache clean --force || true
          '';
        };

        # ─────────────────────────────────────────────────────────────────────
        # DOCKER IMAGE — replaces docker/server.Dockerfile.
        # Build:  nix build .#packages.x86_64-linux.reverie-image
        # Load:   docker load < result
        # ─────────────────────────────────────────────────────────────────────
        # NOTE: The entrypoint.sh, git credential helpers, and optional gh/az
        # installation from the Dockerfile are ported below. If you add new
        # build-arg features, add them here.
        # ─────────────────────────────────────────────────────────────────────
        entrypoint = pkgs.writeShellScript "entrypoint.sh" ''
          #!/usr/bin/env bash
          set -euo pipefail

          # Correct ownership of host bind mounts (daemon creates them as root).
          if [ -d "/home/${runtimeUser}" ]; then
            chown -R ${puid}:${pgid} "/home/${runtimeUser}" 2>/dev/null || true
          fi

          # Drop to the unprivileged runtime account.
          exec setpriv --reuid=${puid} --regid=${pgid} --init-groups \
            "$@"
        '';

        dockerImage = pkgs.buildDockerImage {
          name = "reverie/codeman";
          arch = if pkgs.stdenv.isAarch64 then "linux/arm64" else "linux/x86_64";
          main = "usr/local/bin/entrypoint.sh";
          args = [ "node" "opt/codeman/dist/index.js" "web" ];
          workingDir = "/opt/codeman";
          ports = [ "3000" ];
          env = [
            "CODEMAN_IN_CONTAINER=1"
            "CODEMAN_PORT=3000"
            "HOME=/home/${runtimeUser}"
            "NODE_ENV=production"
            "NPM_CONFIG_PREFIX=/opt/codeman-cli"
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/codeman-cli/bin:/home/${runtimeUser}/.local/bin"
            "PGID=${toString pgid}"
            "PUID=${toString puid}"
            "AZURE_EXTENSION_DIR=/opt/codeman-az-extensions"
          ];
          copyToRoot = runtimeDeps ++ [
            appBuild
            cliBundle
            entrypoint
            pkgs.docker
            pkgs.uv
          ];
          copyTo = {
            "/opt/codeman" = appBuild;
            "/opt/codeman-cli" = cliBundle;
            "/usr/local/bin/entrypoint.sh" = entrypoint;
          };
          setup = ''
            # Create the runtime user (matches Dockerfile PUID/PGID logic).
            groupadd --gid ${pgid} codeman-runtime 2>/dev/null || true
            useradd --uid ${puid} --gid ${pgid} --create-home \
              --home-dir /home/${runtimeUser} --shell /bin/bash \
              ${runtimeUser} 2>/dev/null || true
            chown -R ${puid}:${pgid} /opt/codeman-cli /opt/codeman-az-extensions
            mkdir -p /opt/codeman-az-extensions
            chmod 0755 /usr/local/bin/entrypoint.sh
          '';
        };

        # ─────────────────────────────────────────────────────────────────────
        # DEV SHELL — `nix develop` for local development.
        # ─────────────────────────────────────────────────────────────────────
        devShell = pkgs.mkShell {
          packages = runtimeDeps ++ devDeps;
          NODE_ENV = "development";
          shellHook = ''
            echo "╔══════════════════════════════════════════╗"
            echo "║  Reverie dev shell — Node $(node --version)  ║"
            echo "╚══════════════════════════════════════════╝"
            echo "  npm run dev       # tsx src/index.ts web"
            echo "  npm run build     # tsc + esbuild"
            echo "  npm run test      # vitest"
            echo "  npm run typecheck # tsc --noEmit"
          '';
        };

      in
      {
        devShells.default = devShell;

        packages = {
          default = dockerImage;
          reverie-image = dockerImage;
          reverie-app = appBuild;
          reverie-clis = cliBundle;
        };

        # `nix fmt` for the source tree.
        formatter = pkgs.prettier;
      }
    );
}
