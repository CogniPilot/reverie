# reverie-container-runtime

Linux container entrypoint for the optional GPU image. It supervises the accepted
website entrypoint, selected llama.cpp server, private model relay and display-only
GPU publisher. Children run inside the container; this crate never invokes Nix,
Docker, systemd or a host command. Docker owns restart and explicit-stop policy.

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
default package. Integration tests run with an empty PATH and check configuration
refusal, optional inference, credential retention, helper failure and reaping.
The same feature tests the publisher with a native driver fixture, including
invalid and oversized output, timeouts, private directory and link handling.
Real GPU/image acceptance is separate; see `docs/container-gpu.md`.
