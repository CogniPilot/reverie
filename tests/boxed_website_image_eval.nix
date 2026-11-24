# Pure packaging construction/refusal checks. No derivations, Engine or instance.
let
  id = builtins.concatStringsSep "" (builtins.genList (_: "a") 64);
  # Metadata-only immutable fixture. It earns no executable/native authority.
  clientCapsule = builtins.path { path = ./fixtures/boxed_client_capsule; name = "reverie-metadata-only-client-capsule"; };
  clientManifestDigest = builtins.hashFile "sha256" "${clientCapsule}/opt/reverie-worker-client/manifest.json";
  cfg = {
    version = 1; purpose = "reverie-boxed-runtime-v1"; deployment = "test-office";
    workerImageId = "sha256:${id}"; helperImageId = "sha256:${id}";
    inherit clientManifestDigest; sourceImageIds = [ "sha256:${id}" ];
    apiUrl = "http://reverie:3000";
  };
  baseConfig = {
    Entrypoint = [ "/bin/tini" "-g" "-s" "--" "/immutable/runtime" "/usr/local/bin/reverie-start" ];
    Cmd = [ "reverie" "web" "--host" "0.0.0.0" "--port" "3000" ];
    Env = [ "KEPT=yes" ]; User = "1000:100"; Labels.kept = "yes";
  };
  makeWithRuntime = privateAccessRuntime: runtimeConfiguration: selectedConfig: import ../nix/boxed-website-image.nix {
    pkgs = {
      writeText = _: bytes: assert builtins.fromJSON bytes == runtimeConfiguration;
        "/nix/store/controlled-boxed-configuration";
      dockerTools.buildLayeredImage = value: value;
      tailscale.overrideAttrs = update: assert builtins.length (update {}).patches == 1;
        "/nix/store/controlled-tailscale";
    };
    baseImage = "/nix/store/controlled-base";
    baseConfig = selectedConfig;
    inherit runtimeConfiguration clientCapsule privateAccessRuntime;
  };
  make = makeWithRuntime null;
  image = make cfg baseConfig;
  accepts = value: selected: (builtins.tryEval (builtins.deepSeq (make value selected) true)).success;
  checks = {
    configurationPreserved = image.passthru.runtimeConfiguration == cfg;
    actualManifestSelected = image.passthru.clientManifestDigest == clientManifestDigest;
    mismatchedManifestRefused = !(accepts (cfg // { clientManifestDigest = id; }) baseConfig);
    capsuleIsCopiedAsRealFiles = builtins.match ".*cp -r CAPSULE/opt/reverie-worker-client/\\. opt/reverie-worker-client/.*"
      (builtins.replaceStrings [ "${clientCapsule}" ] [ "CAPSULE" ] image.extraCommands) != null;
    lowerCapsuleChildrenHidden = builtins.match ".*touch opt/reverie-worker-client/\\.wh\\.\\.wh\\.\\.opq.*" image.extraCommands != null;
    capsuleReadOnly = builtins.match ".*chmod -R a-w opt/reverie-worker-client.*" image.extraCommands != null;
    capsuleOwnedByRoot = builtins.match ".*chown -R 0:0 opt/reverie-worker-client.*" image.fakeRootCommands != null;
    immutableBasePreserved = image.fromImage == "/nix/store/controlled-base";
    commandAndUserPreserved = image.config == baseConfig // {
      Env = [ "KEPT=yes" "REVERIE_RUNTIME_BACKEND=boxed-docker-v1" ];
    };
    configAvailableForGpuComposition = image.passthru.reverieConfig == image.config;
    privateAccessIsOptIn = image.contents == [] && !(image.config.Labels ? "org.reverie.tailscale")
      && builtins.match ".*tailscaled.*" image.extraCommands == null;
    privateAccessComposition = let
      gpuConfig = baseConfig // {
        Entrypoint = [ "/bin/tini" "-g" "-s" "--"
          "/nix/store/controlled-runtime/bin/reverie-container-runtime" "/usr/local/bin/reverie-start" ];
      };
      runtime = "/nix/store/controlled-private-runtime";
      selected = makeWithRuntime runtime cfg gpuConfig;
    in selected.contents == [ runtime "/nix/store/controlled-tailscale" ]
      && selected.config == image.config // {
        Entrypoint = [ "/bin/tini" "-g" "-s" "--"
          "${runtime}/bin/reverie-container-runtime" "/usr/local/bin/reverie-start" ];
        Labels = baseConfig.Labels // { "org.reverie.tailscale" = "1"; };
      }
      && builtins.match ".*controlled-tailscale/bin/tailscaled usr/local/libexec/reverie-tailscale/.*"
        selected.extraCommands != null;
    approvedOptionalHelperPreserved = accepts (cfg // { memoryHighHelperImageId = "sha256:${id}"; }) baseConfig;
    approvedOptionalPoolRestorePreserved = let
      selected = cfg // { poolRestoreHelperImageId = "sha256:${builtins.concatStringsSep "" (builtins.genList (_: "b") 64)}"; };
      restored = make selected baseConfig;
    in restored.passthru.runtimeConfiguration == selected
      && restored.passthru.runtimeConfiguration.helperImageId == cfg.helperImageId;
    recoveryHelperIsOptInAndIndependentlyPinned = let
      distinctId = digit: "sha256:${builtins.concatStringsSep "" (builtins.genList (_: digit) 64)}";
      existing = cfg // {
        memoryHighHelperImageId = distinctId "b";
        poolRestoreHelperImageId = distinctId "c";
      };
      selected = existing // { recoveryHelperImageId = distinctId "d"; };
    in (make existing baseConfig).passthru.runtimeConfiguration == existing
      && (make selected baseConfig).passthru.runtimeConfiguration == selected;
    leafWriterHelperIsOptInAndIndependentlyPinned = let
      distinctId = digit: "sha256:${builtins.concatStringsSep "" (builtins.genList (_: digit) 64)}";
      existing = cfg // {
        memoryHighHelperImageId = distinctId "b";
        poolRestoreHelperImageId = distinctId "c";
        recoveryHelperImageId = distinctId "d";
      };
      selected = existing // { leafWriterHelperImageId = distinctId "e"; };
    in (make existing baseConfig).passthru.runtimeConfiguration == existing
      && (make selected baseConfig).passthru.runtimeConfiguration == selected
      && (make selected baseConfig).passthru.runtimeConfiguration.helperImageId == cfg.helperImageId
      && !(accepts (cfg // { leafWriterHelperImageId = null; }) baseConfig)
      && !(accepts (cfg // { leafWriterHelperImageId = "latest"; }) baseConfig)
      && !(accepts (cfg // { leafWriterHelperImageId = "sha256:${id}x"; }) baseConfig);
    backendNotDuplicated = (make cfg (baseConfig // {
      Env = [ "KEPT=yes" "REVERIE_RUNTIME_BACKEND=boxed-docker-v1" ];
    })).config == image.config;
    unknownKeyRefused = !(accepts (cfg // { hostBroker = true; }) baseConfig);
    supportedUrlsAccepted = builtins.all (apiUrl: accepts (cfg // { inherit apiUrl; }) baseConfig) [
      "http://reverie:3000" "https://office.example.test/api/" "http://127.0.0.1:65535"
      "https://Office.Example.Test./api/v1" "http://a" "http://192.168.1.255:0/"
    ];
    everyRequiredKeyRequired = builtins.all (key: !(accepts (builtins.removeAttrs cfg [ key ]) baseConfig))
      (builtins.attrNames cfg);
    malformedValuesRefused = builtins.all (value: !(accepts value baseConfig)) [
      null [] "config" (cfg // { version = 2; }) (cfg // { purpose = "other"; })
      (cfg // { deployment = "../office"; }) (cfg // { workerImageId = "latest"; })
      (cfg // { helperImageId = "sha256:${id}x"; }) (cfg // { memoryHighHelperImageId = null; })
      (cfg // { poolRestoreHelperImageId = null; }) (cfg // { poolRestoreHelperImageId = "latest"; })
      (cfg // { recoveryHelperImageId = null; }) (cfg // { recoveryHelperImageId = "latest"; })
      (cfg // { recoveryHelperImageId = "sha256:${id}x"; })
      (cfg // { clientManifestDigest = "short"; }) (cfg // { sourceImageIds = []; })
      (cfg // { sourceImageIds = [ "latest" ]; })
      (cfg // { sourceImageIds = builtins.genList (_: "sha256:${id}") 33; })
      (cfg // { apiUrl = "http://user:password@reverie"; })
      (cfg // { apiUrl = "http://reverie?token=secret"; })
      (cfg // { apiUrl = "http://reverie#fragment"; })
      (cfg // { apiUrl = "file:///private"; })
      (cfg // { apiUrl = "http://reverie\n"; })
      (cfg // { apiUrl = "http://::1"; })
      (cfg // { apiUrl = "http://reverie:abc"; })
      (cfg // { apiUrl = "http://reverie:99999"; })
      (cfg // { apiUrl = "http://reverie:65536"; })
      (cfg // { apiUrl = "http://reverie:00080"; })
      (cfg // { apiUrl = "http://-reverie"; })
      (cfg // { apiUrl = "http://office..test"; })
      (cfg // { apiUrl = "http://256.1.1.1"; })
      (cfg // { apiUrl = "http://reverie.123"; })
      (cfg // { apiUrl = "http://reverie.0xabc"; })
      (cfg // { apiUrl = "http://reverie.0x"; })
      (cfg // { apiUrl = "http://001.1.1.1"; })
      (cfg // { apiUrl = "http://xn--.example"; })
      (cfg // { apiUrl = "http://" + builtins.concatStringsSep "" (builtins.genList (_: "a") 2048); })
    ];
    conflictingBackendRefused = !(accepts cfg (baseConfig // { Env = [ "REVERIE_RUNTIME_BACKEND=host" ]; }));
    duplicateBackendRefused = !(accepts cfg (baseConfig // {
      Env = [ "REVERIE_RUNTIME_BACKEND=boxed-docker-v1" "REVERIE_RUNTIME_BACKEND=boxed-docker-v1" ];
    }));
    invalidBaseRefused = !(accepts cfg (baseConfig // { Env = [ 1 ]; })) && !(accepts cfg {});
  };
in assert builtins.all (value: value) (builtins.attrValues checks); checks
