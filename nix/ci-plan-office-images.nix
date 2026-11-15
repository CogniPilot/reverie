# Build-only fake office. No production selector, provider override, daemon or private image input.
{ pkgs, src, dependencyConsole, imageNamespace, clientCapsule, clientManifestDigest
, initCapsule ? import ./perf-guest-capsule.nix { inherit pkgs src; }
, workerTools ? import ./worker-tools-capsule.nix { inherit pkgs src; }
, resourceHelper ? import ./docker-resource-helper.nix { inherit pkgs src; }
}:
let
  validNamespace = builtins.isString imageNamespace && builtins.match "reverie-ci-plan-office-[a-f0-9]{32}" imageNamespace != null;
  validDigest = builtins.isString clientManifestDigest && builtins.match "[a-f0-9]{64}" clientManifestDigest != null;
  imageId = value: builtins.isString value && builtins.match "sha256:[a-f0-9]{64}" value != null;
  names = builtins.mapAttrs (_: role: imageNamespace + "-" + role) { source = "source"; worker = "worker"; helper = "helper"; control = "control"; };
  node = pkgs.nodejs_22;
  runtime = pkgs.runCommand "reverie-ci-plan-office-runtime" {
    nativeBuildInputs = [ node pkgs.esbuild ];
  } ''
    ${node}/bin/node --experimental-strip-types ${src}/apps/web/scripts/build-plan-office.mts \
      --source ${src} --modules ${dependencyConsole}/lib/reverie/node_modules \
      --esbuild ${pkgs.esbuild}/bin/esbuild --node ${node}/bin/node --docker ${pkgs.docker-client}/bin/docker --output "$out"
    # Import/CLI sanity only: --help never starts the server or admits Docker operations.
    HOME="$TMPDIR/ci-help-home" ${node}/bin/node "$out/lib/reverie/dist/index.js" --help > "$TMPDIR/help.txt"
    grep -q 'web' "$TMPDIR/help.txt"
    ${node}/bin/node "$out/opt/reverie-ci-plan-provider/bin/claude" --version | grep -q 'synthetic plan fixture'
    ln -s "$out/opt/reverie-ci-plan-provider/bin/claude" "$TMPDIR/claude-alias"
    ${node}/bin/node "$TMPDIR/claude-alias" --version | grep -q 'synthetic plan fixture'
    test -f "$out/lib/reverie/test/fixtures/plan-office-canary.mjs"
    ci_baseline_refusal_exit=0
    ${node}/bin/node "$out/lib/reverie/test/fixtures/plan-office-canary.mjs" --help > "$TMPDIR/baseline-refusal.txt" 2>&1 || ci_baseline_refusal_exit=$?
    test "$ci_baseline_refusal_exit" -eq 1
    grep -Fq 'Use --contract <private reviewed fixture JSON>' "$TMPDIR/baseline-refusal.txt"

  '';
  platform = pkgs.buildEnv { name = "reverie-ci-plan-worker-platform"; paths = [ pkgs.bashInteractive pkgs.coreutils pkgs.findutils pkgs.gnugrep pkgs.gnused pkgs.gawk pkgs.util-linux pkgs.python3 ]; };
  platformClosure = pkgs.closureInfo { rootPaths = [ platform ]; };
  worker = name: pkgs.dockerTools.buildLayeredImage {
    inherit name;
    tag = "latest";
    created = "1970-01-01T00:00:01Z";
    contents = [ platform ];
    fakeRootCommands = ''
      mkdir -p opt/reverie etc home/agent reverie_workspace scratch tmp
      cp -r ${initCapsule}/opt/reverie/perf opt/reverie/perf
      cp -r ${clientCapsule}/opt/reverie-worker-client opt/reverie-worker-client
      cp -r ${workerTools}/opt/reverie-worker-tools opt/reverie-worker-tools
      chmod u+w opt/reverie-worker-tools
      cp ${resourceHelper}/bin/reverie-docker-resources opt/reverie-worker-tools/reverie-docker-resources
      cp -r ${runtime}/opt/reverie-ci-plan-provider opt/reverie-ci-plan-provider
      test "$(sha256sum opt/reverie-worker-client/manifest.json | cut -d' ' -f1)" = '${clientManifestDigest}'
      chmod -R a-w opt/reverie opt/reverie-worker-client opt/reverie-worker-tools opt/reverie-ci-plan-provider
    '';
    config = {
      User = "1000:100"; # actual CREATE overrides with observed positive runner UID:GID
      Entrypoint = [ "/opt/reverie/perf/bin/reverie-worker-init" ];
      Cmd = [];
      WorkingDir = "/tmp";
      Env = [ "HOME=/home/agent" "PATH=/opt/reverie-ci-plan-provider/bin:/opt/reverie-worker-client/bin:/opt/reverie-worker-tools/bin:/bin" "TERMINFO=/opt/reverie-worker-tools/share/terminfo" "TERMINFO_DIRS=/opt/reverie-worker-tools/share/terminfo" "LOCALE_ARCHIVE=/opt/reverie-worker-tools/share/locale/locale-archive" "LC_ALL=C.UTF-8" ];
      Labels = { "org.reverie.worker-client.manifest" = clientManifestDigest; "org.reverie.fixture" = "ci-plan-office-v1"; };
    };
  };
  helperImage = import ./docker-resource-helper-image.nix { inherit pkgs; helper = resourceHelper; name = names.helper; };
  mkControl = { workerImageId, sourceImageIds, helperImageId }:
    assert imageId workerImageId && imageId helperImageId;
    assert builtins.isList sourceImageIds && builtins.length sourceImageIds > 0 && builtins.length sourceImageIds <= 32 && builtins.all imageId sourceImageIds;
    let runtimeConfiguration = {
      version = 1; purpose = "reverie-boxed-runtime-v1"; deployment = imageNamespace;
      inherit workerImageId sourceImageIds helperImageId clientManifestDigest;
      apiUrl = "http://reverie:3000";
    }; configuration = pkgs.writeText "ci-plan-boxed-runtime.json" (builtins.toJSON runtimeConfiguration); in pkgs.dockerTools.buildLayeredImage {
      name = names.control; tag = "latest"; created = "1970-01-01T00:00:01Z";
      passthru = { inherit runtimeConfiguration; };
      contents = [ runtime node pkgs.docker-client platform pkgs.tmux pkgs.which pkgs.procps ];
      fakeRootCommands = ''
        mkdir -p etc/reverie opt/reverie/apps bin fixture scratch tmp
        cp -r ${clientCapsule}/opt/reverie-worker-client opt/reverie-worker-client
        chmod -R a-w opt/reverie-worker-client
        cp ${configuration} etc/reverie/boxed-runtime.json
        chmod 0444 etc/reverie/boxed-runtime.json
        ln -s ${runtime}/lib/reverie opt/reverie/console
        ln -s ${runtime}/lib/reverie opt/reverie/apps/web
      '';
      config = {
        User = "1000:100";
        Entrypoint = [ "${node}/bin/node" "${runtime}/lib/reverie/dist/index.js" ];
        Cmd = [ "web" "--host" "0.0.0.0" "--port" "3000" ];
        WorkingDir = "/fixture";
        Env = [ "HOME=/fixture/home" "REVERIE_DATA_DIR=/fixture/data" "REVERIE_RUNTIME_BACKEND=boxed-docker-v1" "REVERIE_OWNER_SETUP=1" "REVERIE_API_URL=http://reverie:3000" "PATH=/opt/reverie-ci-plan-provider/bin:/bin" ];
        Labels = { "org.reverie.fixture" = "ci-plan-office-v1"; };
        ExposedPorts = { "3000/tcp" = {}; };
      };
    };
in assert validNamespace && validDigest; {
  inherit runtime platform platformClosure helperImage mkControl;
  sourceImage = worker names.source;
  workerImage = worker names.worker;
  metadata = { version = 1; purpose = "reverie-ci-plan-office-images-v1"; sourcePath = toString src; inherit imageNamespace clientManifestDigest; imageNames = names; controlPort = 3000; sourceUserOverrideRequired = true; controlUserOverrideRequired = true; };
}
