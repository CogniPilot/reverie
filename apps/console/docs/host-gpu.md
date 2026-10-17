# GPU readout from the host

The console runs where it cannot see the GPU, so the sidebar's GPU chip reads a small JSON file that a host-side publisher keeps
fresh. The console only reads it (`GET /api/system/gpu`).

- **Where:** the console looks in `REVERIE_GPU_STATUS_FILE` alone when that is set; otherwise `/host-published/gpu.json` (the host's
  read-only bind mount of one directory), then `host/gpu.json` next to the console's data directory (for example
  `/instances/<instance>/runtime/host/gpu.json`) until the mount exists. The first place with a fresh reading wins.
- **Format:**
  ```json
  { "updatedAt": 1800000000000,
    "gpus": [ { "name": "RTX 4090", "utilization": 63, "memoryUsedMb": 4096, "memoryTotalMb": 24576 } ] }
  ```
  `updatedAt` is epoch milliseconds (seconds are accepted); without it the file's modification time is used. A single GPU may
  also be written as those fields at the top level. `name` is optional and is not passed on: the route answers numbers only. With several GPUs the chip shows the busiest and adds the memory up.
- **Fresh means under 60 seconds old.** Publish about every 30 seconds. A missing, older, future-dated, malformed or over-64 KB file means "no reading", and the
  chip is hidden. Write it atomically (temporary file, then rename). A link or FIFO at that path is ignored.
