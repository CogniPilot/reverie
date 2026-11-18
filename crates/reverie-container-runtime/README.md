# reverie-container-runtime

Linux startup and supervision for the office images. The normal and GPU images
use the same `reverie-container-start` executable to prepare the mounted instance
directory and exec the console. It creates the private runtime credential only
when needed, backs up console state before advancing the image version, and leaves
owner account and policy files to the backend. It uses the Linux system random
source for first-start credentials.

The optional GPU supervisor manages the website, selected llama.cpp server,
private model relay and display-only GPU publisher. The crate runs inside the
container without invoking Nix, Docker, systemd or a host command. Docker owns
restart and explicit-stop policy.

Model configuration comes from operator-selected deployment environment values.
Inputs are existing read-only weights, an optional vision projector and a private
API key retained in instance storage. The default socket belongs to that storage;
a migration may retain the existing shared socket used by employee containers.
The crate reuses `reverie-local-model` for sampling presets, key custody and safe
abandoned-socket recovery. It does not implement model computation.

`config.rs` validates model settings. `main.rs` owns process and signal lifetimes
and the private disposable telemetry directory. A helper failure or website exit
settles siblings before exit; Docker applies its declared restart policy.

`reverie-gpu-publisher` queries the local NVIDIA driver with a deadline and a
bounded response. It publishes the console's `updatedAt` and `gpus` JSON
through a directory descriptor and an exclusive temporary file. Container
telemetry uses `--output` and clears the reading when the driver is
unavailable.

The `test-fixtures` feature enables native Rust child fixtures, excluded from the
default package. The startup test uses a PATH with no interpreter to check
credential retention, simultaneous first starts, backup retry, provider ordering
and speech startup. The GPU supervisor tests use an empty PATH and check
configuration refusal, optional inference, credential retention, helper failure
and reaping.
The same feature tests the publisher with a native driver fixture, including
invalid and oversized output, timeouts, private directory and link handling.
Real GPU/image acceptance is separate; see `docs/container-gpu.md`.
