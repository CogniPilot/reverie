# Real R-enabled cold-launch acceptance

This is one ignored library-service test. It is not a deployment command or a
replacement for owner authorization. Default tests do not run Docker effects.
The real-image run requires independent source review, a successfully built and
qualified native-child image, a known local Engine image ID, and a bounded
execution approval for this exact case and its cleanup.

`REVERIE_NATIVE_COLD_INPUTS` names a private bounded JSON fixture-input file with
exactly `version: 1`, `purpose: "native-r-cold-j-fixture-v1"`, `image`, `base`,
`annex`, `dockerProgram`, and `tenantParent`. Each artifact reference has exactly
`path` and `sha256`. These are input DATA: the real readonly qualifier checks
the immutable provenance/program and loaded image before any container create.
The Docker executable must be an immutable canonical Nix-store `docker`.
The endpoint is fixed to the local daemon; inherited Docker context, credentials,
TLS and remote-host selection are excluded.

`tenantParent` is the actual NSS home plus `reverie/cj`, owned mode0700. Every
run exclusively creates a new short tenant directory there. Company, employee,
session, state, plans/storage, Office sockets, work and configuration are
synthetic and private. The source retains R; it does not install a fake kernel
observer. Its READY setup is private filesystem DATA, followed by the genuine
Gate constructor, admission/flocks and native kernel observations. The ordinary
admission shape uses 4096 MiB per worker, 49152 MiB pool accounting, CPU quota
zero and no selected pool provider. The 64 MiB fixture host reserve is not a
production headroom claim. No production cgroup parent is selected or written.

The test creates one bounded private server anchor from the exact image, then
uses `prepare_shared_service`, `bind_listener` and normal `poll_handler` to
drive a genuine cold J and its original handler Job. A fixed finite shell job
waits for a private work-file marker while the separate anchor checks native
bare-RECORD compatibility against the same synthetic Office socket. The normal
J exercises `--pane-exit`, the real `.exit0`, terminal output and EOF. Normal
service scheduling may let the real completion supervisor stop the worker
before C; the trace records that distinction without claiming C-only behavior.
Actual stopped CID, released storage/R locks, closed Office/handler and complete
service closure are required before nonforce removal of the two original CIDs.

All unknown native CLI, service or stop results retain their original owners and
tenant evidence. There is no name-only removal, force removal, image removal,
signal retry or blanket cleanup. An unknown result is a failed acceptance run.

This bounded workload does not call the upstream Office HTTP backend, a model
provider or production website. The isolated anchor has no production network;
the real Office socket and relay lifecycle are exercised, not bridge-address
lookup or backend API health. It grants no perf, soft-RAM, pool activation,
systemd-installation or global native-service singleton acceptance.
