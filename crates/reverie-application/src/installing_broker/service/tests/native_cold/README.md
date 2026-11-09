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
production headroom claim. The schema requires the legacy
`reverie-workers.slice` declaration; admission mode omits it from Docker's
creation arguments. The test checks both the actual empty Docker parent and
the process's cgroup path before proceeding. No production parent is joined
or written.

The test creates one private server anchor from the exact image with the
limits reader's required minimum of 512 MiB and no swap allowance, then
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
On failure, the same service's historical completed-create diagnostics are
saved as private `create-diagnostic-N.json` files. Argument, stdout and stderr
byte arrays preserve the original client capture; the exact synthetic worker
name must match. These files supply no absence, retry or cleanup authority.

This bounded workload does not call the upstream Office HTTP backend, a model
provider or production website. The isolated anchor has no production network;
the real Office socket and relay lifecycle are exercised, not bridge-address
lookup or backend API health. It grants no perf, soft-RAM, pool activation,
systemd-installation or global native-service singleton acceptance.

The separately ignored
`actual_native_viewer_eof_reconnect_preserves_same_live_provider_and_command`
case uses the same exact inputs and original 150-second attempt budget. It calls
the same held-workload helper; the existing finite terminal command is unchanged,
not duplicated or a claim that shell runtime has been retired. It closes only
the first website-side Unix socket while the command is live, collects the real
published handler thread, checks original socket/Hold settlement and lifecycle
transients, then attaches with `attachOnly: true` to the same SID. It repeats EOF
on that reuse viewer and attaches once more before releasing the original command.
No protocol exit, terminal input, explicit reconciliation or provider-stop request
is used to simulate either website disappearance.

Each live boundary requires the exact original Created CID, original Started
registration, actual running/unpaused/nondead init PID, kernel start tick, Docker
StartedAt and original runtime publication bytes/exit nonce to match. The original command receipt and workload-release marker must remain absent,
the original storage lease held and R admission available. Checkpoints retain
private fixed-workload frame bytes and the actual registry's read-only typed
storage diagnostic. The existing typed provider observer additionally supplies
the actual pane controller and its single direct command child, already checked
against the Engine topology, kernel root/namespaces and repeated process reads.
Their PID, birth, parent, argv digest, executable identity and namespaces must
remain identical at every boundary. No new process lookup, shell inspection or
caller-selected PID is added. The same Runtime metadata owner and process reader
are retained across checks, known-closed before global service shutdown, and kept
whole with original typed failures on uncertainty. Missing/incomplete native knowledge is not a cleanup grant.
After the final attach, normal command output, `.exit0`, owned stop, physical
handler/service/Office/storage closure and original-CID cleanup remain mandatory.

Compilation and test listing do not authorize this Docker case. The exact selector
needs a separate one-attempt execution approval outside the host rollout quiet
window; pinning the test process alone does not pin its created containers. Unknown
or failed results retain the original whole attempt and tenant, without replay,
guessed-CID cleanup, manual release or resetting any marker.
