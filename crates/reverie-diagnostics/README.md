# Bounded diagnostic transport

`stderr(&[u8])` and `stdout(&[u8])` each offer at most 1024 bytes in one
best-effort attempt to their fixed inherited descriptor. They take no
stdio lock, wait for no peer and retry no short/interrupted write. Callers
must settle owned resources first; delivery never changes the operation result
or supplies cleanup evidence.

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
