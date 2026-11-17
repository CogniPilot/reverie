# GPU readout from the Docker runtime

The GPU image passes the selected device through to the container. The native GPU
publisher writes a private runtime file every 15 seconds and the website reads
the path supplied in `REVERIE_GPU_STATUS_FILE` for `GET /api/system/gpu`.
The GPU readout stays hidden when the runtime supplies no path.
[Container GPU setup](../../../docs/container-gpu.md)

- **Format:**
  ```json
  { "updatedAt": 1800000000000,
    "gpus": [ { "name": "RTX 4090", "utilization": 63, "memoryUsedMb": 4096, "memoryTotalMb": 24576 } ] }
  ```
  `updatedAt` is epoch milliseconds (seconds are accepted); without it the file's modification time is used. A single GPU may
  also be written as those fields at the top level. `name` is optional and is not passed on: the route answers numbers only. With several GPUs the chip shows the busiest and adds the memory up.
- **Fresh means under 60 seconds old.** A missing, older, future-dated, malformed or over-64 KB file hides the chip.
  The publisher writes atomically. The website ignores links and non-regular files.
