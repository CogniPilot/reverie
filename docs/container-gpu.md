# Self-contained Docker GPU runtime

The optional GPU image runs the website, llama.cpp inference and GPU display
telemetry inside the same container. Docker owns their lifetime and restart
policy. No Reverie package belongs in the host's personal Nix profile, and no
Reverie systemd service or host telemetry publisher is required.

The host supplies Docker, its NVIDIA driver and NVIDIA Container Toolkit/CDI.
Grant only the selected GPU device to the container. The website receives no
Docker socket or host service-control capability.

## Build and start

Build the image for the selected GPU compute capability, for example `8.6`:

```bash
nix build --impure --expr '(builtins.getFlake (toString ./.)).lib.mkContainerGpuImage {
  system = "x86_64-linux";
  capability = "8.6";
}' --out-link result-gpu
docker load --input result-gpu
```

The Nix build is a packaging step. The running container never invokes Nix,
Docker, systemctl, downloads a model, or installs software on the host. CUDA
and llama.cpp are included in the image. `capability = ""` selects a CPU build.

Use the repository's `docker/compose.gpu.yml` for a fresh deployment. Select
`REVERIE_GPU_DEVICE` (a CDI name such as `nvidia.com/gpu=GPU-…`),
`REVERIE_MODELS_DIR` (an existing host directory) and `REVERIE_MODEL_FILE`
(the GGUF filename within it). The model mount is read-only. Optional values
select the model alias, context, matching vision projector path under `/models`,
and sampling profile. KV cache defaults to `f16` for model compatibility;
`REVERIE_MODEL_CACHE_TYPE=q8_0` selects the smaller quantized cache for models
whose attention dimensions support it. Then run:

```bash
docker compose -f docker/compose.gpu.yml up -d
```

The website listens on host loopback port 3000. Inference listens only on
container loopback port 8092 and requires its API key. The key is generated
privately under `/instances/default/runtime/model/api-key` and retained in the
data volume. `REVERIE_LOCAL_MODEL_KEY_FILE` may select an existing private key
when migrating an already configured local plan. Preserve that key and the
existing model alias rather than changing employee or plan identities.

The model loads at container startup. A private Unix socket and a supervised
loopback HTTP relay retain the existing model transport without a host inference
process. `REVERIE_LOCAL_MODEL_SOCKET` can retain an existing shared model socket
location for isolated employee containers during migration. A failed inference,
relay, telemetry, or website process settles its siblings and exits; Docker applies the declared
restart policy. An explicit Docker stop remains stopped. Telemetry reads
the passed GPU directly and is consumed from a private container runtime file.
It needs neither `/host-published` nor a host publisher.

## Existing offices and updates

The example Compose volumes describe a new office. An existing deployment must
retain its accepted data/home volumes or binds, workspace, scratch, employee
controller connections, identity and resource limits. Do not start a second
website writer against live company data. Use the reviewed deployment workflow
to preview, stop, retain and replace the existing container with the GPU image.

`lib.mkContainerGpuImage` also accepts an immutable `baseImage` archive and its
`baseConfig`. This supports a GPU-only rollout of an accepted application image
without implicitly upgrading the website or migrating company data.

An existing Docker employee office also needs its immutable
`/etc/reverie/boxed-runtime.json`. Package that configuration with
`lib.mkBoxedWebsiteImage { system = "x86_64-linux"; baseImage = gpuImage;
runtimeConfiguration = pairedConfiguration; }`, where `gpuImage` is the
result of `lib.mkContainerGpuImage`. The factory preserves the image command,
user, GPU runtime and configuration values, adds a root-owned read-only
configuration file and the current source's protected worker API client capsule,
and selects the Docker backend. It refuses a configuration whose
`clientManifestDigest` differs from that actual capsule's manifest. It does not read or edit a
running instance. The build-time URL subset accepts HTTP(S) DNS/IPv4 endpoints
with an optional port/path and excludes credentials, query strings and fragments.
Select a future `workerImageId` built with that same current capsule and its exact
manifest digest before constructing the website. This is an explicit new default
target selection, not a rewrite of existing employee bindings. Keep the accepted
global helper image, existing source image IDs and other configuration values;
include the retained worker image among allowed source IDs for future moves.
Existing Ready employees retain their own worker image and manifest bindings. A
website update does not replace their immutable clients, repair their old CLI
behavior, or qualify them for a future plan transfer.

The capsule files are copied as root-owned read-only regular files. An
[OCI opaque directory marker](https://github.com/opencontainers/image-spec/blob/v1.1.1/layer.md#opaque-whiteout)
hides all lower-layer capsule children, so upgrading a base with an older capsule
cannot retain unlisted stale files. Image construction is not physical runtime or
old-worker compatibility acceptance.

`nix build .#workerClientCapsule` exposes the same canonical capsule used by the
website factory. Its manifest is at `opt/reverie-worker-client/manifest.json`;
`workerNativeClient` is a different artifact. The maintainer adapter
`scripts/build-boxed-worker-image.mts` replaces the whole client directory in an
immutable worker base before copying the new capsule. Its fixed build-only
root step runs `/bin/rm` with an exact argument vector, then restores the
inspected numeric `UID:GID`. Unsupported or empty source users refuse before
image tagging or building. The optional tools overlay keeps its existing behavior.
The adapter still verifies the entire target configuration and ordered source
layer prefix. Artifact construction does not qualify a running worker, native
plan protocol, provider readiness, or an old employee client.

After verifying the container's local-model endpoint and fresh GPU readings,
retire any legacy host `reverie-local-model`, GPU telemetry and source-updater
services. Keep model files and credentials. The old host services are not part
of this deployment and must not be required for container restart.

Updates use Docker image replacement, retaining the same deployment definition
and persistent volumes. A host update daemon and a writable host request mount
are unnecessary. The container is not granted a Docker socket to replace itself.
