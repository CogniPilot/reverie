# Packaging data only. Runtime identity, authority and Engine observations are
# independently checked by DockerEmployeeRuntime. No live instance is read.
{ pkgs, baseImage, baseConfig, runtimeConfiguration, clientCapsule, name ? "reverie-boxed"
, privateAccessRuntime ? null, gpuProjectionCompiler ? null }:
let
  cfg = runtimeConfiguration;
  clientRoot = "${clientCapsule}/opt/reverie-worker-client";
  clientManifestDigest = builtins.hashFile "sha256" "${clientRoot}/manifest.json";
  required = [ "version" "purpose" "deployment" "workerImageId" "clientManifestDigest"
    "sourceImageIds" "helperImageId" "apiUrl" ];
  optional = [ "memoryHighHelperImageId" "poolRestoreHelperImageId" "recoveryHelperImageId"
    "leafWriterHelperImageId" ];
  matches = pattern: value: builtins.isString value && builtins.match pattern value != null;
  imageId = matches "sha256:[a-f0-9]{64}";
  decimal = max: value: matches "(0|[1-9][0-9]{0,4})" value
    && builtins.fromJSON value <= max;
  apiUrl = value:
    let
      parsed = if builtins.isString value then builtins.match
        "https?://([A-Za-z0-9.-]+)(:([0-9]+))?(/[A-Za-z0-9_./~%-]*)?" value else null;
      host = builtins.elemAt parsed 0;
      port = builtins.elemAt parsed 2;
      domain = if matches ".*[.]" host then builtins.substring 0 (builtins.stringLength host - 1) host else host;
      labels = builtins.filter builtins.isString (builtins.split "[.]" domain);
      last = builtins.elemAt labels (builtins.length labels - 1);
      ipv4 = builtins.length labels == 4 && builtins.all (decimal 255) labels;
      dns = builtins.all (label: matches "[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?" label
        && !(matches "[xX][nN]--.*" label)) labels
        # WHATWG treats a numeric/hex final label as IPv4, even in a DNS-looking name.
        && !(matches "([0-9]+|0[xX][a-fA-F0-9]*)" last);
    in parsed != null && builtins.stringLength value <= 2048
      && builtins.stringLength domain <= 253 && (port == null || decimal 65535 port)
      && (ipv4 || dns);
  valid = builtins.isAttrs cfg
    && builtins.all (key: builtins.hasAttr key cfg) required
    && builtins.all (key: builtins.elem key (required ++ optional ++ [ "workerGpu" ])) (builtins.attrNames cfg)
    && cfg.version == 1 && cfg.purpose == "reverie-boxed-runtime-v1"
    && matches "[A-Za-z0-9][A-Za-z0-9_.-]{0,99}" cfg.deployment
    && imageId cfg.workerImageId && imageId cfg.helperImageId
    && builtins.all (key: !(builtins.hasAttr key cfg) || imageId cfg.${key}) optional
    && matches "[a-f0-9]{64}" cfg.clientManifestDigest
    && builtins.isList cfg.sourceImageIds && builtins.length cfg.sourceImageIds > 0
    && builtins.length cfg.sourceImageIds <= 32 && builtins.all imageId cfg.sourceImageIds
    # Conservative build-time subset: no userinfo, query, fragment or whitespace.
    # The owning URL parser still validates the selected endpoint at startup.
    && apiUrl cfg.apiUrl;
  env = baseConfig.Env or [];
  tailscale = import ./tailscale-serve.nix { inherit pkgs; };
  gpuEntrypoint = baseConfig.Entrypoint or [];
  runtimeIndex = 4;
  newEntrypoint = builtins.genList
    (i: if i == runtimeIndex then "${privateAccessRuntime}/bin/reverie-container-runtime" else builtins.elemAt gpuEntrypoint i)
    (builtins.length gpuEntrypoint);
  prefix = "REVERIE_RUNTIME_BACKEND=";
  backend = builtins.filter (value: builtins.isString value
    && builtins.substring 0 (builtins.stringLength prefix) value == prefix) env;
  config = baseConfig // {
    Env = env ++ (if backend == [] then [ "${prefix}boxed-docker-v1" ] else []);
  } // (if privateAccessRuntime == null then {} else {
    Entrypoint = newEntrypoint;
    Labels = (baseConfig.Labels or {}) // { "org.reverie.tailscale" = "1"; };
  });
  gpu = cfg.workerGpu or null;
  baseConfiguration = pkgs.writeText "reverie-boxed-runtime.json"
    (builtins.toJSON (builtins.removeAttrs cfg [ "workerGpu" ]));
  configuration = if gpu == null then baseConfiguration else
    pkgs.runCommand "reverie-boxed-gpu-runtime.json" { } ''
      ${gpuProjectionCompiler}/bin/reverie-container-runtime --worker-gpu-projection ${baseConfiguration} \
        ${pkgs.lib.escapeShellArgs ([ gpu.device ] ++ gpu.driverStorePaths)} > "$out"
    '';
in
assert valid;
assert gpu == null || (gpuProjectionCompiler != null
  && builtins.attrNames gpu == [ "device" "driverStorePaths" ]
  && builtins.isString gpu.device && builtins.isList gpu.driverStorePaths);
assert cfg.clientManifestDigest == clientManifestDigest;
assert builtins.isAttrs baseConfig && builtins.isList (baseConfig.Entrypoint or null)
  && baseConfig.Entrypoint != [] && builtins.all builtins.isString baseConfig.Entrypoint
  && builtins.isList env && builtins.all builtins.isString env
  && (backend == [] || backend == [ "${prefix}boxed-docker-v1" ]);
assert privateAccessRuntime == null || (
  builtins.length gpuEntrypoint == 6
  && builtins.genList (builtins.elemAt gpuEntrypoint) 4 == [ "/bin/tini" "-g" "-s" "--" ]
  && matches "/nix/store/[^/]+/bin/reverie-container-runtime" (builtins.elemAt gpuEntrypoint runtimeIndex)
  && builtins.elemAt gpuEntrypoint 5 == "/usr/local/bin/reverie-start"
);
pkgs.dockerTools.buildLayeredImage {
  inherit name;
  tag = "latest";
  created = "1970-01-01T00:00:01Z";
  maxLayers = 125;
  contents = if privateAccessRuntime == null then [] else [ privateAccessRuntime tailscale.package ];
  fromImage = baseImage;
  passthru = { reverieConfig = config; runtimeConfiguration = cfg; inherit clientManifestDigest; };
  extraCommands = ''
    mkdir -p etc/reverie opt/reverie-worker-client
    cp -r ${clientRoot}/. opt/reverie-worker-client/
    # OCI opacity hides every lower-layer capsule file, including unlisted old
    # files. The new regular files and this marker belong to the same layer.
    touch opt/reverie-worker-client/.wh..wh..opq
    chmod -R a-w opt/reverie-worker-client
    cp ${configuration} etc/reverie/boxed-runtime.json
    chmod 0444 etc/reverie/boxed-runtime.json
    ${if privateAccessRuntime == null then "" else tailscale.install}
  '';
  fakeRootCommands = ''
    chown 0:0 etc/reverie etc/reverie/boxed-runtime.json
    chown -R 0:0 opt/reverie-worker-client
    chown 0:0 opt
    chmod 0755 opt
    chmod 0755 etc/reverie
    chmod 0444 etc/reverie/boxed-runtime.json
  '';
  enableFakechroot = true;
  inherit config;
}
