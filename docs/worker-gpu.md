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

For a laptop already using the rootless Docker capability profile, keep the
same UID/GID, subordinate-ID ranges, base tools and mount-layout settings. The
existing `lib.workerDockerImage` factory accepts an optional **boolean**
`browser = true`; omitted and `false` produce the exact same derivation in the
same source graph. The browser variant adds the existing browser runtime and
`org.reverie.worker.browser=1`, retaining the rootless profile. Do not replace a
UID/GID capability image with the generic UID-2000 `workerBrowserImage`.

For example, from the reviewed checkout, with existing mapping inputs selected
by the owner (these defaults must already be authorized by `/etc/subuid` and
`/etc/subgid`):

```sh
image_output="$(mktemp -d /tmp/reverie-worker-gpu.XXXXXX)"
export REVERIE_GPU_BUILD_FLAKE="$(pwd -P)"
export REVERIE_GPU_BUILD_UID="$(id -u)" REVERIE_GPU_BUILD_GID="$(id -g)"
nix build --impure --expr '
  let f = builtins.getFlake (builtins.getEnv "REVERIE_GPU_BUILD_FLAKE");
  in f.lib.workerDockerImage {
    system = builtins.currentSystem;
    uid = builtins.fromJSON (builtins.getEnv "REVERIE_GPU_BUILD_UID");
    gid = builtins.fromJSON (builtins.getEnv "REVERIE_GPU_BUILD_GID");
    subuidStart = 100000; subgidStart = 100000; subidCount = 65536;
    browser = true;
  }' --out-link "$image_output/result"
```

Device access alone does not require a browser image: keep an existing qualified
UID/GID image when project flakes/private Nix already provide the needed tools.
The broker's immutable image selection applies to future creations in that
broker. Browser binaries alone grant no device access. Prefer the owner-private
`employeeGpuGrants` map so a grant follows the permanent employee identity:

```json
{
  "employeeGpuGrants": {
    "11111111-1111-1111-1111-111111111111": "nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  }
}
```

These identifiers are synthetic. Resolve the current SID and generation through
the trusted company/storage metadata, never a name, title or request-provided
employee ID. A historical/retired SID does not inherit the employee grant. An
explicit legacy `gpuGrants` SID entry takes precedence; its existing policy bytes
are preserved. Both maps default empty, with at most 32 owner selections combined.
New employee grants change only the selected laptop's projected policy; unrelated
legacy policy labels and creation arguments stay byte-equivalent. OFF/vacation
continues to block startup independently; a permission is not a wake request.

Numeric indices, `all`, raw device paths, flags and wildcards remain invalid.
The existing engine producer still adds only `--device` plus one exact NVIDIA
CDI UUID. GPU grants require reviewed configuration and selected-laptop recreation;
the resource-only hot reload cannot change them. An older broker does not accept
the new map: update its reviewed package/configuration through the normal inactive
service workflow. No running container is resized or granted a device in place.

CPU stays uncapped by default; memory/task limits, read-only root, private homes,
scratch and networks stay unchanged. The ordinary profile retains capability
drop and no-new-privileges. The existing rootless Docker profile retains its
narrow SETUID/SETGID capabilities, pinned seccomp/idmap rules and existing
namespace settings; it intentionally differs from the ordinary NNP profile.
This GPU option adds no capability or sandbox exception. Device access does not impose a GPU memory quota. A granted process
can contend with the local model server beyond this test helper's safeguards.

## Host CDI and browser sandbox prerequisites

The optional tools use the application's pinned flake and existing local Linux
engine/driver. The ordinary deployment remains usable without a GPU or toolkit.
No NixOS configuration, kernel-driver installation, daemon reconfiguration or
system-service activation is performed by this feature.

Run the metadata-only owner-local preflight after selecting the actual employee,
physical CDI UUID and already loaded immutable image:

```sh
nix run .#worker-gpu -- --config "$HOME/reverie/runtime/worker-isolation/broker.json" \
  --employee OWNER_SELECTED_EMPLOYEE_UUID --device nvidia.com/gpu=GPU-OWNER_SELECTED_UUID \
  --image sha256:QUALIFIED_IMAGE_DIGEST --browser --cdi-sha256 REVIEWED_SPEC_DIGEST
```

It binds the current company SID/generation and intent, actual local engine/CDI
specification bytes, immutable image UID/GID profile, existing laptop labels,
RAM/swap/PID limits, and current kernel process/root/namespace metadata. It uses
only fixed engine metadata commands, bounded file reads and child processes.
It cannot install, reload, restart, grant access or run a GPU workload. Its JSON
is a review aid, never native effect authority, a VRAM reservation or a rendering
pass. Missing/ambiguous facts exit 77 without a fallback. YAML support is bundled
with this optional tool; the ordinary worker needs no YAML dependency.

On a host lacking the prerequisites, first install a supported NVIDIA kernel
driver and CDI-capable engine through its normal owner-selected installation.
[Docker enables CDI by default from version 28.3.0](https://docs.docker.com/reference/cli/dockerd/#configure-cdi-devices); its configured specification
directories must contain the reviewed driver/device definition. The pinned
`workerGpuToolkit` output supplies `nvidia-ctk` for an explicit private candidate:

```sh
nix shell .#workerGpuToolkit --command nvidia-ctk cdi generate \
  --format=json --device-name-strategy=uuid \
  --output "$HOME/reverie/runtime/gpu/nvidia.candidate.json"
```

Create that private directory first. Generation is not installation: publishing
into an engine's configured CDI directory requires its legitimate owner/admin
setup. The app never writes `/etc/cdi`, changes a daemon, uses the engine as an
admin workaround or edits a personal host configuration. Unsupported installation
stays unavailable; do not change an already working driver to prepare source.

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

## Selected-laptop activation and continuity

Source tests, built tooling and metadata checks do not enable a laptop. First
qualify the exact image and current pinned CDI edits with a separately admitted
throwaway worker using the same UID/GID/rootless profile and no business accounts.
In particular, driver-library dependencies, CDI hooks under the read-only root
and private Nix store, device identities, and the real browser sandbox remain
native gates. Do not add privileged mode, broad devices, writable host Nix or
`--no-sandbox` to make a probe pass. Rendering/compute needs its own bounded
acceptance; an existing RAM ceiling does not limit GPU memory.

Before changing a working employee laptop, coordinate a pause/checkpoint window.
Retain its previous image/configuration and preserve the same employee home/Nix
roots, session/account/conversation binding and owner ON/OFF/vacation intent.
Update the inactive broker package/configuration without waking employees; capture
and recheck all unrelated laptop/provider identities and office-phone continuity.
Then recreate only the selected laptop through its supported owner-authorized
lifecycle. Existing peer policies and caps must stay exact. A GPU grant uses that
laptop's existing allocation; it does not consume the separate fixed host-browser
job reservation or authorize that job. No scientific input, threshold, account or
permission changes follow from these installation steps.

A device grant is authority in the canonical admission domain. Neither GPU map
is excluded from that domain digest. If the admission root is already
provisioned, changing a GPU map requires a supported owner-controlled policy
reconciliation after all claims, host jobs and uncertain/install fences are
settled, retaining the existing operation journal and profile lineage. The
resource-only reload cannot perform that transition. Do not delete/recreate a
marker or journal, ignore the authority field, or create a second ledger to make
it fit. Without that supported transition, enablement remains unavailable.
An installed protected terminal generation also pins the configuration's raw
bytes/inode: settle and rebind it around a legitimate configuration CAS. The
metadata report exposes different current/proposed domain digests, not a permit.
