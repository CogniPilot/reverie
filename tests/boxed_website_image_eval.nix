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
  make = runtimeConfiguration: selectedConfig: import ../nix/boxed-website-image.nix {
    pkgs = {
      writeText = _: bytes: assert builtins.fromJSON bytes == runtimeConfiguration;
        "/nix/store/controlled-boxed-configuration";
      dockerTools.buildLayeredImage = value: value;
    };
    baseImage = "/nix/store/controlled-base";
    baseConfig = selectedConfig;
    inherit runtimeConfiguration clientCapsule;
  };
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
    approvedOptionalHelperPreserved = accepts (cfg // { memoryHighHelperImageId = "sha256:${id}"; }) baseConfig;
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
