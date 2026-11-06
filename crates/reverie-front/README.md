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
For the explicit Linux child qualifications, set `REVERIE_TEST_NODE` to the
pinned installed Node path and run
`cargo test --locked -p reverie-front -- --ignored`. That run includes a real
twelve-second unresponsive-child deadline check. These checks use only isolated
fixtures and loopback sockets; they do not open an instance database or deploy a
service.
