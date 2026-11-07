# Bounded diagnostic transport

`stderr(&[u8])` offers at most 1024 bytes in one best-effort attempt. It takes no
stdio lock, waits for no peer and retries no short/interrupted write. Callers
must settle owned resources first; delivery never changes the operation result
or supplies cleanup evidence.

The Linux adapter uses nonblocking socket sends, independently reopened
nonblocking FIFO/TTY descriptions, and `O_NOCTTY`. It preserves inherited file
flags. Regular files use the inherited descriptor so offset and append semantics
remain intact. All reopened descriptors get one checked close. FIFO output is
omitted if a consumer changed Rust's ignored SIGPIPE disposition; the adapter
never changes process-global signals. Descriptor/signal ownership belongs to
the embedding standalone runtime, which must not concurrently rebind stderr.

There is no hard promise for kernel/device/filesystem latency. Other platforms
explicitly return `Unsupported`. This is not a logging framework or a product
validation/policy dependency. The native worker child is the first consumer.
