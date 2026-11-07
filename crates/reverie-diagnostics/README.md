# Bounded diagnostic transport

`stderr(&[u8])` and `stdout(&[u8])` each offer at most 1024 bytes in one
best-effort attempt to their fixed inherited descriptor. They take no
stdio lock, wait for no peer and retry no short/interrupted write. Callers
must settle owned resources first; delivery never changes the operation result
or supplies cleanup evidence.

`terminal_resize_report(&[u8])` is the separate live-worker purpose. It uses
the same fixed fd2 adapter and refuses reports over 1024 bytes rather than
truncating them. The viewer remains owned; delivery error ends the transport
operation while retaining its native/resource owners for their real finalizer.
The report is attempted before later receipt/X work. This deliberately replaces
Python's potentially blocking print/flush with bounded best-effort delivery:
backpressure, a partial write or an interrupted write is an error, never report
success or a cleanup acknowledgement. It does not broaden the post-cleanup
contract of `stderr`/`stdout`.

The Linux adapter uses nonblocking socket sends, independently reopened
nonblocking FIFO/TTY descriptions, and `O_NOCTTY`. It preserves inherited file
flags. Regular files use the inherited descriptor so offset and append semantics
remain intact. All reopened descriptors get one checked close. FIFO output is
omitted if a consumer changed Rust's ignored SIGPIPE disposition; the adapter
never changes process-global signals. Descriptor/signal ownership belongs to
the embedding standalone runtime, which must not concurrently rebind either
selected descriptor. There is no caller-selected descriptor or path API.

There is no hard promise for kernel/device/filesystem latency. Other platforms
explicitly return `Unsupported`. This is not a logging framework or a product
validation/policy dependency. The native worker child uses stderr; the fixed
guest Nix bootstrap offers its bounded raw progress tails only after owned
settlement. Delivery never changes the actual child status.
