# Inert artifacts for an explicitly reviewed owned native-Q test only.
# No instance configuration, credential, service or capability is installed.
{ pkgs, src, console, client }:
let
  fixtureConsole = pkgs.runCommand "reverie-native-q-fixture-console" { } ''
    mkdir -p "$out/lib/reverie"
    cp -rs ${console}/lib/reverie/. "$out/lib/reverie/"
    # Remove only this new output's link; the product console is immutable.
    unlink "$out/lib/reverie/dist/index.js"
    cp ${src}/apps/web/test/fixtures/resource-native-q-website.mjs "$out/lib/reverie/dist/index.js"
  '';
in {
  console = fixtureConsole;
  image = pkgs.dockerTools.buildLayeredImage {
    name = "reverie-native-q-fixture";
    tag = "source-fixture";
    created = "1970-01-01T00:00:01Z";
    contents = [ fixtureConsole pkgs.nodejs_22 client ];
    extraCommands = ''
      mkdir -p etc fixture run/reverie-native-q tmp
      printf 'root:x:0:0:root:/root:/bin/false\nfixture:x:1000:100:Fixture:/fixture/home:/bin/false\n' > etc/passwd
      printf 'root:x:0:\nusers:x:100:\n' > etc/group
    '';
    config = {
      User = "1000:100";
      Entrypoint = [ "${pkgs.nodejs_22}/bin/node" "${fixtureConsole}/lib/reverie/dist/index.js" ];
      WorkingDir = "/fixture";
      ExposedPorts."3000/tcp" = { };
      Env = [
        "HOME=/fixture/home" "TMPDIR=/fixture/tmp"
        "REVERIE_DATA=/fixture/instance" "REVERIE_DATA_DIR=/fixture/data"
        "REVERIE_CASES_PATH=/fixture/cases" "REVERIE_SHARED_WORKSPACE_PATH=/fixture/workspace"
        "REVERIE_SHARED_ATTACHMENTS_PATH=/fixture/attachments" "REVERIE_NO_AUTOSTART=1"
      ];
    };
  };
}
