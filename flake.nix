{
  description = "Reverie: configurable CTO and experts with persistent memory";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      fleet = pkgs.python3Packages.buildPythonPackage {
        pname = "reverie-fleet";
        version = "0.1.0";
        src = ./.;
        pyproject = true;
        build-system = [ pkgs.python3Packages.setuptools ];
        checkPhase = "python -m unittest discover -s tests -t .";
      };
      # Host tool: show or live-change the container memory limit. writeShellApplication
      # adds its own shebang and runs shellcheck, so the script's shebang is dropped here
      # (a second `#!` line would be SC1128).
      container-memory = pkgs.writeShellApplication {
        name = "container-memory";
        runtimeInputs = [ pkgs.coreutils pkgs.gawk pkgs.gnused pkgs.gnugrep ];
        text = pkgs.lib.removePrefix "#!/usr/bin/env bash\n" (builtins.readFile ./scripts/container-memory);
      };
    in {
      packages.${system}.default = fleet;
      apps.${system} = {
        default = { type = "app"; program = "${fleet}/bin/fleet-memory"; };
        container-memory = { type = "app"; program = "${container-memory}/bin/container-memory"; };
      };
      devShells.${system}.default = pkgs.mkShell {
        packages = [ pkgs.python3 pkgs.nodejs pkgs.git pkgs.podman ];
      };
    };
}
