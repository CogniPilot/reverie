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

Controls precede round-robin stream queues. Credit is coalesced per connection;
end remains behind that connection's queued data. Abort discards pending stream
packets and settles their leases. Closed ids follow the contract's monotone-id
rule: old grants become unusable and are forgotten; late data is discarded
before acknowledging the channel reader, with no socket queue or second grant.
No unbounded closed-id table is kept. Waiters receive freed capacity before the
just-consumed connection can replenish its grant. Idle outstanding grants remain
reserved until used or closed, as required by the reviewed protocol.

A generation fault closes all clients and listeners. There is no response
substitution, request replay or child respawn. Normal cleanup explicitly joins
socket tasks and channel threads, then reaps the child. The first process signal
sets one absolute deadline: the existing TS ten-second force-exit period plus
two seconds. Repeated signals cannot extend it. KILL begins at that deadline if
needed; kernel reap latency has no promised wall-clock bound, and a failed wait
never counts as confirmed cleanup. Exit follows the child, or 70 for front faults.

This source is under implementation and review. Plain TCP and bridge tags are
implemented. TLS binds currently return ENOTSUP rather than accepting plaintext.
TLS, actual S2 child integration, Nix packaging and service selection remain
separate acceptance gates. Nothing selects or deploys this binary yet.

Run `cargo xtask verify` in the development environment for the ordinary gate.
For the explicit Linux child qualifications, set `REVERIE_TEST_NODE` to the
pinned installed Node path and run
`cargo test --locked -p reverie-front -- --ignored`. That run includes a real
twelve-second unresponsive-child deadline check. These checks use only isolated
fixtures and loopback sockets; they do not open an instance database or deploy a
service.
