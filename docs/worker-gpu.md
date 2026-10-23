# Opt-in worker GPU and browser capability

The source supports an optional browser image and owner-selected GPU grants.
Ordinary workers receive no GPU device. Building these artifacts does not change
the host driver, deploy an image, wake an expert or restart a laptop. Actual
container NVIDIA browser acceptance is pending; a native browser result cannot
establish it.

## Nix artifacts and grants

`browserRuntime` contains Nix-pinned Chromium, Vulkan diagnostics, GLVND dispatch
libraries and `reverie-browser-gpu-probe`. `workerBrowserImage` adds that runtime
to the worker image. `workerImage` and the console image remain minimal. No
Playwright download, apt dependency list, CUDA toolkit or kernel driver is added.

```sh
nix build .#browserRuntime --out-link "$HOME/scratch/reverie/browser-runtime"
nix build .#workerBrowserImage --out-link "$HOME/scratch/reverie/worker-browser-image"
```

Use the reviewed immutable browser worker image ID in the external owner-only
broker configuration. The image choice currently applies to all workers managed
by that broker; browser binaries grant no GPU access by themselves. Add optional
`gpuGrants` only for explicitly selected session UUIDs:

```json
{
  "gpuGrants": {
    "11111111-1111-1111-1111-111111111111": "nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  }
}
```

These are synthetic identifiers. Select the actual session and reviewed physical
GPU UUID on the host; organizational titles and employee names grant no access.
An absent or empty mapping is valid. Wildcards, numeric GPU indices, `all`, raw
device paths and arbitrary engine flags are rejected. The only added engine
arguments are `--device` and that selected CDI name. Runtime execution requests
cannot change the grants. GPU grants participate in the worker policy digest;
changing them is an owner-managed configuration/recreation step, not a live
permission toggle. Preserve current desired-running/vacation state at cutover.

CPU stays uncapped by default, and existing memory/task limits, read-only root,
capability drop, no-new-privileges, per-agent homes, scratch and networks remain
enforced. Device access does not impose a GPU memory quota. A granted process
can contend with the local model server beyond this test helper's safeguards.

## Host CDI and browser sandbox prerequisites

The host needs native Docker CDI support and a reviewed NVIDIA CDI specification
matching its running driver. On NixOS the pinned module offers
`hardware.nvidia-container-toolkit.enable` and
`hardware.nvidia-container-toolkit.device-name-strategy = "uuid"`. These are
host settings requiring ordinary owner activation when a change is needed;
Reverie does not enable or activate them. Do not change an already working driver
or restart the engine merely to prepare this source capability.

Review the selected CDI entry **and** global `containerEdits`: CDI can inject
device nodes, read-only driver mounts, environment and host hooks. UUID validation
alone does not constrain a host administrator's CDI definition. Verify that only
the selected GPU's NVIDIA/DRM nodes are exposed, matching NVIDIA userspace
libraries and their Nix runtime dependencies resolve, and EGL vendor/Vulkan ICD
JSON files resolve inside the worker. Use the actual injected paths; do not
hard-code host store hashes or mount the entire `/nix/store` or `/dev/dri`.

Chromium's namespace sandbox must work under the worker UID and existing engine
seccomp policy. A native sandbox pass does not establish that nested namespaces
work in Docker. A sandbox error is a blocker to investigate, not grounds to add
`--no-sandbox`, privileged mode, unconfined seccomp, display sockets, host PID
access, engine/control sockets or console-private mounts. Do not add these as
workarounds. A required compatibility policy needs a narrowly reviewed change.

## Bounded verification

Run the bundled probe as the actual worker user in an approved maintenance/test
environment. It uses a local HTTP page, loopback-only DevTools and a disposable
profile in task scratch; no remote page, provider login or expert history is read.
It checks fresh VRAM before any workload and again after optional inference
preflight. Missing/invalid metrics or less than 4096 MiB free means **skip**
(exit 77), never a hardware pass. `REVERIE_NVIDIA_SMI` may select the reviewed
injected binary if it is outside the image's PATH, such as `/usr/bin/nvidia-smi`.

```sh
reverie-browser-gpu-probe \
  --gpu GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee \
  --requester selected-expert \
  --report /scratch/reports/gpu-log.jsonl
```

The browser uses `--headless --enable-gpu --use-angle=vulkan`, enables Vulkan
compositing with `--enable-features=Vulkan --disable-vulkan-surface`, and retains
its sandbox. It checks a WebGL pixel and a four-integer WebGPU compute readback, and
requires NVIDIA identity in both renderer and adapter diagnostics with a false
fallback flag. SwiftShader, llvmpipe, lavapipe and missing identities fail.
Diagnostics include Chromium's GPU device/feature report. A software-rendered
screenshot, visible device node, or successful `nvidia-smi` is insufficient.

Without model arguments a successful result is `hardware-pass`: model coexistence
is explicitly unverified. For a full automated coexistence probe add an
owner-selected chat-completions endpoint, exact model ID and agreed latency bound:

```sh
reverie-browser-gpu-probe \
  --gpu GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee \
  --requester selected-expert --report /scratch/reports/gpu-log.jsonl \
  --model-url http://AUTHORIZED_ENDPOINT/v1/chat/completions \
  --model-id OWNER_SELECTED_MODEL --model-max-latency-ms 5000
```

`--model-key-env NAME` reads an optional credential from the environment without
logging it. The fixed synthetic request asks for eight output tokens and discards
the response content. Inference is probed before, during a bounded tiny compute
loop and after graphics; each request times out after ten seconds. Browser
startup/DevTools/workload are separately bounded, and the compute loop has an
eleven-second deadline. One JSON line records requester, time, selected device,
free VRAM before/after, renderer/readback evidence, result and model probe status
and latency. A pass covers these probes only; review host logs separately for
model restarts, OOM or GPU reset and compare latency against the agreed baseline.

This is an advisory free-VRAM check, not a reservation: another process can
allocate after it. Keep workloads small while sharing a GPU with Qwen. SLAM's
own CUDA/ROS dependencies and dataset/device permissions require a separate
project runtime; this browser capability does not provide them.

Before enabling a selected laptop, verify the immutable image, selected CDI
mount/device diff, browser sandbox, NVIDIA Vulkan identity, WebGL/WebGPU outputs,
and bounded model inference with no restart/reset. Retain the old non-GPU image
and stopped laptop for rollback at the agreed maintenance cutover. Preserve
other experts, current running intent, model settings and all durable homes.

## Primary references

- [Pinned NixOS NVIDIA toolkit module](https://github.com/NixOS/nixpkgs/blob/a033e66ab94a6bedf2c3d58d93a36319d3cbbbaf/nixos/modules/services/hardware/nvidia-container-toolkit/default.nix)
- [NVIDIA CDI support and driver injection](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html)
- [Docker daemon CDI configuration](https://docs.docker.com/reference/cli/dockerd/#configure-cdi-devices)
- [Chromium hardware GPU in headless mode](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/using-gpu-hardware-in-headless-chrome.md)
- [Chrome's documented Vulkan headless options](https://developer.chrome.com/blog/supercharge-web-ai-testing)
