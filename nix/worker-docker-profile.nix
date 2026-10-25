{ pkgs }:
let
  upstream = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/moby/profiles/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json";
    hash = "sha256-ZBa0d3B4WkGsWQc83HfZ/phRffJ5ncg+8gfmIt4wU/Y=";
  };
in pkgs.runCommand "reverie-worker-docker-seccomp.json" {
  nativeBuildInputs = [ pkgs.python3 ];
} ''
  python3 ${./worker-docker-profile.py} ${upstream} "$out"
''
