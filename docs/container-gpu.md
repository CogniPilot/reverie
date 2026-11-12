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

After verifying the container's local-model endpoint and fresh GPU readings,
retire any legacy host `reverie-local-model`, GPU telemetry and source-updater
services. Keep model files and credentials. The old host services are not part
of this deployment and must not be required for container restart.

Updates use Docker image replacement, retaining the same deployment definition
and persistent volumes. A host update daemon and a writable host request mount
are unnecessary. The container is not granted a Docker socket to replace itself.
