# Docker runtime and retired host launch selections

The supported office and employee runtime is Docker-contained. Docker owns
container restart. Do not install a Reverie host broker, model launcher, GPU
publisher, standalone terminal viewer or the former host engine/website bridge
units. Host Docker, NVIDIA drivers and NVIDIA Container Toolkit/CDI remain
ordinary platform prerequisites.

The old `reverie service` CLI is a hidden compatibility refusal. Install, start,
stop, status, logs and uninstall arguments return exit status 2 with Docker
guidance; they do not load the native service installer or control a supervisor.
Its action tests run the real Commander parser with writes, network and process
effects blocked. Pure legacy unit-builder tests remain until their library retires.

The public flake no longer selects the legacy broker/service installers, host
model launcher, host GPU publisher, isolation installer, standalone viewer or
H/resource service installers. Their former nix run instructions in older
manual sections are historical migration records. They are not a supported
way to reinstall the retired stack. The old Python isolation installer and
its tests have been removed. Existing private data, account homes,
journals, unknown operation fences and installed services are not altered by
this source change. Actual deactivation needs a separate reviewed operation.

The shared GPU publisher now lives at apps/container/gpu-telemetry.ts and is
selected privately by the GPU image producer. CUDA/llama build inputs and the
container supervisor remain. The reverie-local-model library still supplies
pure argument, sampling, key and socket functions to the container runtime;
deleting that shared crate would break the current image.

CI evaluates checks.<system>.boxedRuntimeBoundary before Rust verification.
It checks the finite reviewed public export sets, refuses retired unit
templates and requires Docker/GPU build inputs. Pure mutations cover returning
broker/model/GPU/viewer/service exports, a renamed unknown export, a restored
unit and missing Docker inputs. The GPU recipe is also evaluated with inert
inputs to preserve its internal supervisor, telemetry and inference wiring.
This checks the declared surface; it does not prove arbitrary program behavior.

The unreferenced `nix/local-model.nix`, `nix/ops-core.nix` and
`nix/owner-terminal-packages.nix` host-entry factories have also been removed.
The boundary check refuses their reintroduction. Their shared Rust libraries,
container image producers and actively referenced component fixtures remain.
The retired owner-terminal package factories and their Python host executable
have also been removed. Existing historical proofs still use the legacy
protocol code.
The workspace and Kokoro commands now use Rust. Memory and Hands still bring
Python into the image. The remaining runtime and acceptance callers must
migrate before the root `python/` tree can be retired.

The persistent OPS host installer has been removed from the source. The Docker
runtime still ships the native headless OPS client. Legacy broker and model
implementations, their compatibility tests, routine and cleanup host tools, and
the default package's unboxed development web launcher remain migration work.
The old viewer component still has its actual isolated image acceptance through
a checks-only fixture; its public production package is retired. Current Docker
employee terminal acceptance must additionally use the mandatory synthetic office
lane and actual CLI/callback/TTY witnesses. The legacy component is not that proof.
