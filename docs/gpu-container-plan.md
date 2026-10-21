# Proposed GPU access at the next scheduled recreation

Status: design for review. No GPU devices, host driver configuration, container
flags, model-server settings, or GPU admission policy have been changed.
This joins the next reviewed image/recreation batch; it does not justify another
restart. Record owner approval for the expanded device access and the reviewed
configuration before deployment.

## Host integration and device selection

Use NVIDIA CDI with rootless Podman/crun. Enable the NVIDIA Container Toolkit in
the host's reviewed NixOS configuration (`hardware.nvidia-container-toolkit.enable`),
then generate and inspect the CDI specification against the running driver. Host
activation uses normal owner authentication. Do not bypass missing OS access.

The reviewed create command selects one CDI device:

```text
--device=nvidia.com/gpu=<name-from-reviewed-CDI-spec>
```

Keep the existing user namespace, agent UID, capabilities, networking, published
ports and durable mounts. Do not add privileged mode, a host engine socket, host
PID access, display-server sockets, or the whole host `/nix/store`. NVIDIA's NixOS
integration supplies selected driver and runtime paths; review those read-only
mounts and their closure instead of mounting the entire store.

Inspect whether that device's CDI entry already supplies the associated DRM render
node. If needed, add only the selected node, for example
`--device=/dev/dri/renderD128:/dev/dri/renderD128`. Discover the node from its PCI
association rather than assuming the example applies on every host. Add a DRM
card node only if the headless acceptance test demonstrates it is necessary.
Do not expose every GPU or blindly mount the entire `/dev/dri` directory.

Existing host permissions may already allow the rootless owner to use the nodes.
Only if group access is required, review crun's `--group-add=keep-groups` behavior
against the upcoming per-agent UID design. Do not change host device modes or
relax SELinux/seccomp as a default workaround.

## Image, driver libraries and graphics discovery

The host keeps its kernel NVIDIA driver. Do not install a second kernel driver or
an unrelated Debian NVIDIA driver version inside the image. CDI supplies the
matching NVIDIA userspace libraries and `nvidia-smi`; verify the Nix-patched ELF
interpreter/runtime paths as well as the visible executable.

Proposed final-stage image additions are the generic dispatch/diagnostic packages
`libvulkan1`, `vulkan-tools`, `libegl1`, `libgles2`, `libgl1` and `libglx0`, keeping
existing packages and removing apt lists as in the browser-dependency change.
Most dispatch libraries may already be dependencies of the installed browser
packages. Review the actual apt delta before applying it. CUDA development tools,
NVCC, a CUDA base image and Xorg are unnecessary for this initial browser scope.

Verify that the injected NVIDIA Vulkan ICD and GLVND EGL vendor JSON files resolve
to the matching imported NVIDIA libraries. Resolve the actual CDI paths rather
than hard-coding host Nix store names. Verify `vulkaninfo --summary` and an EGL/GL
probe as the agent user. An environment variable listing driver capabilities alone
is not proof that native CDI imported the required libraries.

For headless Chromium, first test the documented `--enable-gpu` and
`--use-angle=vulkan` path. Record the minimal working flags, actual ANGLE renderer,
Vulkan device and WebGPU adapter. Do not call SwiftShader/lavapipe/software output
a hardware GPU pass. Do not disable browser security or validation globally to
make a graphics probe pass. Any additional compatibility flags require review.

## Sharing the GPU with the local model service

The owner selected the light approach: short browser GPU tests, with no lease
system, MPS deployment or host monitor. Direct GPU access is shared access, not a
hard VRAM quota or protection against every allocation spike.

Each GPU test helper must:

1. Read fresh free-VRAM data for the selected device before starting. Skip the GPU
   test if free memory is below 4096 MiB (4 GiB); unavailable or invalid metrics
   also mean skip rather than guessing. A skipped test is not a GPU pass.
2. During acceptance, prove that the host model service keeps answering while a
   hardware WebGL/WebGPU job runs. Include bounded local inference, not only an
   HTTP health endpoint, and keep model settings and service state unchanged.
3. Append one JSON line per run to the task's `reports/gpu-log.jsonl`: requester,
   time, selected device, free VRAM before and after, run/skip result, and model
   probe outcome. Do not include prompts or conversation content.

This check neither reserves VRAM nor prevents another process from allocating it
afterwards. The owner accepted this limitation for short browser tests. Revisit
resource controls if real contention appears; do not expand the scope beforehand.

## Acceptance and rollback at the scheduled recreation

1. Review the host CDI/device/mount diff, final-stage image diff, test-helper pre-check,
   ownership changes and rollback. Reconcile the canonical console source first.
   Carry the reviewed browser dependencies and runtime/console changes in the image.
2. Before cutting over, save current container/image identity and create settings;
   retain the stopped old container and all durable histories. Preserve all employee,
   session and native-thread identities according to the established recreate flow.
3. As the configured agent user (initially UID 2000), `nvidia-smi` must show the
   selected physical GPU and correct driver; `vulkaninfo` must identify NVIDIA.
   Repeat relevant device access checks under the planned per-agent UIDs.
4. After the free-VRAM pre-check, Chromium must create a WebGL context, render a tiny scene
   with checked readback, and run a small WebGPU compute/readback test. Capture
   adapter/renderer diagnostics demonstrating NVIDIA hardware, not a fallback.
5. Probe model health and one bounded, non-private local inference before, during
   and after the graphics job. Record latency, availability and free VRAM before/after;
   retain no private prompt or conversation content. Require successful replies,
   no model restart and no OOM/GPU reset. Agree a latency bound
   against the measured baseline before calling the test a pass.
6. Verify that the helper skips when free VRAM is below 4 GiB or metrics are
   unavailable, and records the skip. Do not intentionally exhaust VRAM or put
   the model service at risk to test the check.
7. If acceptance fails, preserve logs and select the retained non-GPU container at
   the same maintenance cutover. Do not prune containers, images or user histories.
   Leave GPU access disabled until the integration is corrected and reviewed.

## Primary references

- [NVIDIA CDI support](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html)
- [NVIDIA graphics and utility capabilities](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html)
- [NixOS toolkit module](https://github.com/NixOS/nixpkgs/blob/master/nixos/modules/services/hardware/nvidia-container-toolkit/default.nix)
- [Podman CDI directory option](https://docs.podman.io/en/stable/markdown/podman.1.html)
- [Chromium hardware GPU in headless mode](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/using-gpu-hardware-in-headless-chrome.md)
- [NVIDIA MPS CUDA memory limits](https://docs.nvidia.com/deploy/mps/appendix-environment-variables.html)
- [NVIDIA MIG supported GPUs](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/supported-gpus.html)
