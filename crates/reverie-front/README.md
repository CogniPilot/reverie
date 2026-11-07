# Reverie front

`reverie-front` owns public sockets for one installed TypeScript child. It relays
opaque bytes through the shared `route_frames_v2` contract. HTTP, authentication,
WebSockets and route policy stay in the existing TypeScript service during phase
2a. The installing service supplies Node, its installed entrypoint and original
arguments; protocol requests cannot choose a command or environment overlay.

The Unix process adapter creates one bidirectional socket pair and passes the
child endpoint on fd 3 through `command-fds`. It drops the parent Command owner
immediately after spawn so that owner cannot hide child-channel EOF. Ordinary
Node descendants must not inherit this channel; the pinned Node qualification
checks pipe, inherited stdio and detached modes, with explicit fd inheritance as
a positive control. This does not claim Windows service support.

The front reuses the contracts reader and connection table. Its dedicated channel
reader waits for consumption of each frame before reading another. Each socket
has one issued read and one write in flight. Payload leases cover reservations,
read buffers, queues and writes; unused read capacity is returned, and retained
short buffers shed the original allocation. Adjacent fragments coalesce into
64 KiB packets. The bounds are 4,096 retained transports, 32 MiB per direction
and 1 MiB of pending priority controls. The codec and active writer have bounded
single-frame encoding/decoding scratch space in addition to these payload pools.

Operational diagnostics use the shared `reverie-diagnostics` owner. Rejected
connections are dropped before reporting the cap. The Linux adapter offers one
bounded nonblocking diagnostic attempt; full stderr cannot stall the actor or
cleanup. Diagnostic delivery never changes the outcome. Other platforms report
an unsupported diagnostic transport; kernel/device latency has no hard bound.

Controls precede round-robin stream queues. Credit is coalesced per connection;
end remains behind that connection's queued data. Abort discards pending stream
packets and settles their leases. Closed ids follow the contract's monotone-id
rule: old grants become unusable and are forgotten; late data is discarded
before acknowledging the channel reader, with no socket queue or second grant.
No unbounded closed-id table is kept. Waiters receive freed capacity before the
just-consumed connection can replenish its grant. Idle outstanding grants remain
reserved until used or closed, as required by the reviewed protocol.

The front reports cumulative native-write completion with `written`, separate
from permission to send more bytes (`credit`). Receipts deliberately lag partial
writes: a bounded packet must finish its socket write and transport flush before
its receipt advances or its payload lease is released. This observes socket
acceptance, not client delivery. At most one pending receipt per connection is
coalesced in the priority controls. A normally draining connection remains owned
until its final receipt has actually been written to the channel; enqueueing or
submitting it is insufficient. Abort discards pending receipts and cancels both
socket tasks. A receipt already committed to the channel writer may finish and
is settled by the peer after its abort. Generation loss discards pending output.

A generation fault closes all clients and listeners. There is no response
substitution, request replay or child respawn. Normal cleanup explicitly joins
socket tasks and channel threads, then reaps the child. The first process signal
sets one absolute deadline: the existing TS ten-second force-exit period plus
two seconds. Repeated signals cannot extend it. KILL begins at that deadline if
needed; kernel reap latency has no promised wall-clock bound, and a failed wait
never counts as confirmed cleanup. Exit follows the child, or 70 for front faults.

Plain TCP, bridge tags and service-configured TLS are implemented. TLS uses the
same Node-generated certificate/key files and fails a secure bind when they are
unavailable. See the [TLS boundary](src/tls/README.md) for buffer/admission bounds,
modern-cipher compatibility restrictions and the remaining cutover qualification.
Actual S2 integration, Nix packaging and service selection have separate receipts;
this source change does not select or deploy the binary.

Run `cargo xtask verify` in the development environment for the ordinary gate.
For the explicit Linux library child/TLS qualifications, set
`REVERIE_TEST_NODE` and `REVERIE_TEST_OPENSSL` to pinned installed executables,
then run `cargo test --locked -p reverie-front --lib -- --ignored`.
These checks use only isolated fixtures and loopback sockets; they do not open
an instance database or deploy a service.

Build the unselected native package with `nix build .#rustFront`. It uses the
shared Rust workspace projection, retaining only the core, contracts, diagnostics
and front crates plus their locked dependencies. The derivation runs ordinary
front tests; real Node/adapter qualifications remain explicit separate gates.
It does not modify the console launcher or select the front in any service.
The paired adapter harness accepts `REVERIE_TEST_FRONT` as an explicit absolute
executable path to qualify this installed artifact instead of Cargo's binary.

The separate `real_adapter` integration target needs both compiled TypeScript
paired fixtures. Build `apps/web/test/rust-front/front-child.ts` and
`direct-child.ts` together with esbuild's `--bundle --packages=external
--platform=node --format=esm` options, placing their `.mjs` outputs under
`apps/web/out/` so the existing application dependencies remain resolvable.
Set `REVERIE_FRONT_CHILD_FIXTURE` and `REVERIE_DIRECT_CHILD_FIXTURE` to those
absolute output paths, `REVERIE_TEST_NODE` to pinned Node, and optionally
`REVERIE_TEST_FRONT` to the installed native executable. Run
`cargo test --locked -p reverie-front --test real_adapter -- --ignored
--test-threads=1`.

The paired cases cover large-response shutdown before and after genuine finish,
verified TLS and encrypted peer facts, a second request on the same connection,
SSE backpressure with byte-exact HTTP-decoded bodies and ordered drains, and
client write half-close. TLS uses the same existing leaf certificate/key fixtures
in both modes with normal certificate and hostname verification. Hyper is a
test-only HTTP decoder; the production front still relays opaque bytes.
