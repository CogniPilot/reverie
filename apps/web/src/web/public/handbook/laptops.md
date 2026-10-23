# Office laptops

An expert's tools run on its work laptop: a separate container with a private home, terminal and persistent scratch. The remote model supplies reasoning; the CLI inside the laptop connects that model to its tools.

The website is the office communication and management service. Restarting the website can leave laptop programs running. Restarting the laptop itself ends processes inside it; preserving the same CLI across that restart needs a separately supervised backend and is not guaranteed by the website/laptop split.

## Protection

CPU is uncapped by default and shared fairly. Memory and task ceilings prevent a runaway laptop from exhausting the whole host. Threads count toward the task limit. Limits and admission budgets are owner-selected host policy; check actual deployment settings before quoting numbers.

Each laptop has an init process to reap orphaned children. An unavailable broker must fail closed rather than execute tools inside the website container.

## Boundaries

Laptops get explicitly shared project mounts, selected accounts and a scoped office API. They do not get the engine socket, host-control socket or console private state. Internet access does not imply access to colleagues' laptops. There is no peer SSH network by default.

Use the scoped API base in REVERIE_API_URL. Do not copy owner service tokens or passwords into a laptop to bypass missing permissions.

Optional browser/GPU access needs explicit host grants and a validated image. Native graphics success alone does not prove container graphics, WebGPU or safe coexistence with model inference.

See [Work and scratch](/handbook/work) and [Power and restarts](/handbook/power).
