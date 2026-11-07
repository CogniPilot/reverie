# Native worker client

`reverie-worker-exec` is the Linux client for the existing private worker-broker
protocol. It neither starts a broker nor executes commands on the host. The
broker retains authorization, resource-reference admission, stop fencing and
effect ownership. A command, role, socket path or reference creates no grant.

Environment key filtering shares the Core worker-launch vocabulary. Client
transport/value encoding rules remain separate from broker request bounds.

Clap help groups terminal, office-control and private-metadata operations, with
examples and troubleshooting. Existing worker-exec flags remain direct options;
there is no broker/child subcommand, custom deployment script or Python fallback.
Unknown/malformed arguments exit 2; connection/protocol failures exit 1. Terminal
completion preserves the broker exit value modulo 256, including negative signal
statuses. Explicit SIGINT/SIGTERM cancellation restores terminal settings before
returning 128 + signal. Stdin EOF retains the existing exit 1 behavior.

| Operation | Existing wire behavior |
| --- | --- |
| Terminal launch | J launch, I input, R resize; O output, X exit or E refusal |
| Attach-only | Same launch with attachOnly:true |
| Resource launch | L with the exact reference/request envelope |
| Office control | C with one of the eight existing actions; J result |
| Goal custody | G fixed action; closed J projection, at most 32768 bytes |
| Custody stream | Bare G stdin byte per fresh call; framed J stdout reply |
| Failure metadata | T fixed command-failures request; strictly validated J report |

Stop-agent preserves the exact session, optional epoch-ms deadline and optional
32-hex fence; a fence requires a deadline. Settle-stop requires session and fence
and accepts no deadline. These requests are sent once. A lost reply never causes
reconnect, replay, a fabricated stop settlement or automatic rollback.

The launch environment uses the existing exact allowlist, including its uppercase
provider prefixes; host endpoints, PATH, HOME and owner tokens are excluded.
Allowed Unicode values and command arguments retain their UTF-8 bytes. Invalid
UTF-8 in a selected value or command argument is refused rather than replaced;
unrelated non-UTF-8 environment keys cannot match the ASCII allowlist and are
ignored. The broker independently validates cwd,
command, environment, dimensions and grants.

## Native custody and interactive behavior

Before connecting, the client holds an O_PATH descriptor to the private,
current-UID socket inode. It checks the connected SO_PEERCRED UID and rechecks
the named endpoint's device/inode/mode/owner against that anchor. The held inode
cannot be recycled into an apparently matching replacement. No socket is
removed or repaired. Metadata responses recheck endpoint identity and the fixed
deadline before checked connection closure and stdout publication.

Each Goal call has one monotonic 1.75-second connect/send/read/validation budget;
fragments never renew it. Report calls have one 3-second budget, and controls one
120-second budget. Terminal sessions remain interactive without a total runtime
deadline. Frame payloads are bounded to 256 KiB; custody has its smaller bound.
Closed metadata decoders reject unknown and nested duplicate fields, invalid
types and all floating number tokens. The report decoder retains the legacy
integer -0 spelling, 10-character token bound, employee order, category/count
limits and explicit disabled/unavailable invariants. No command text is exposed.

Signal tracking precedes initial dimensions and publication. One bounded output
frame is serviced per relay turn so a busy peer cannot starve keyboard input or
resize. Pipe/TTY stdout uses a verified independent nonblocking descriptor with
O_NOCTTY; inherited file-status flags are unchanged. Socket output uses nonblocking
send. Regular-file output preserves its shared offset and append behavior.
Cancellation checks bound poll waits and output chunks; ordinary OS filesystem
I/O is still subject to kernel/device availability.

Linux unsafe syscalls are confined to `src/native.rs` and its output adapter.
Fault injection is compiled only into owning unit tests. There are no runtime
test modes, alternate endpoints or test authority flags.

## Package and protected-consumer transition

`workerNativeClient` builds a standalone ELF. `workerNativeClientManifest` names
the native successor explicitly: version 2, purpose
`resource-replacement-native-client-v2`, canonical executable, executableSHA256,
argvPrefix:[executable], and brokerWireVersion:1. It never masquerades as the
Python-shaped v1 manifest. A one-time same-PID self-exec normalizes argv0 before
any endpoint access, preserving protected kernel exe/argv checks for PATH and
symlink invocations.

The source selects this native package as workerExec and its native manifest as
workerResourceClientManifest together. There is no Python launcher branch or
selected v1 manifest fallback. Its coordinated consumers include:

- `worker_resource_actor._client_program` and `_program`: closed native manifest,
  immutable ELF bytes and exact single-token prefix.
- `website_image_provenance`: native manifest validation and ELF code-file pin.
- `resource_actor_install._programs`, protected website.bootstrap and
  `resolve_launch`: exact selected executable/argv and actual kernel identity.
- The website Goal channel, command-failure reader, ordinary session launches,
  resource launches and office controls: the same selected worker-exec entry.

Existing installed bootstrap/provenance facts need separately authorized,
supported activation. Source/package tests do not rewrite or activate them. The
Python broker, child launcher and other runtime modules remain separate migration
work; this client does not claim that the whole service closure is Python-free.

Owned fixtures cover native socket framing, all modes, hostile G/T responses,
fixed deadlines, lost replies, Unicode, actual PTY input/resize/restoration,
output backpressure, cancellation, parent flags and kernel argv normalization.
They contact no live broker or service.
