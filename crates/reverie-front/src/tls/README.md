# TLS transport boundary

The installing service supplies paired, absolute `--tls-cert` and `--tls-key`
paths. S5 must pass the paths belonging to Node's actual `configuredDataDir()`;
this adapter does not derive another instance name, read environment configuration
or create certificates. Node retains `getOrCreateSelfSignedCert`. Each secure
BindRequest loads the files after that request, before binding its port, so main
and bridge retain the same per-bind capture semantics. Plain binds do not read
these files. Missing, invalid or incompatible material fails the secure bind;
there is no plaintext fallback. Installed symlinks are followed, as in Node.
Every opened material file has one checked close through the safe nix wrapper;
close failure prevents bind success, and a concurrent read/metadata failure is
retained alongside it. Unlike Node's native UTF-8 reader's fatal close assertion,
the front reports BindFailed. It never retries close on a possibly reused fd.

The explicit ring provider supports TLS 1.2 and 1.3, no client-certificate
authentication, and ALPN `http/1.1`. There is no process-global provider mutation.
A successful handshake emits the original socket addresses and `encrypted=true`
through the unchanged frame schema; failed handshakes emit no ConnOpen.

This is not an assertion of every OpenSSL default being identical. The pinned
Node 22.23.3 default HTTPS server accepts
`TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256`; ring/rustls deliberately excludes CBC,
static RSA and finite-field DHE suites. Modern AEAD clients are qualified. The
owner cutover must acknowledge this compatibility restriction. No legacy crypto
or permissive client trust verifier is added.

## Bounds and lifetime

Enabling TLS first reserves one generation-owned 4 MiB incoming slice for
established-session parser scratch. This slice stays charged independently of
issued application credits; a TLS bind fails if it cannot be reserved. Both
listeners and their retained transports share it. A fair semaphore admits one
synchronous rustls poll to that workspace at a time. Once acquired, its guard
drops when that call returns, including Pending/error. Read, write, flush and
shutdown each have their own bounded acquisition wait state retained across
polls, so split halves cannot overwrite each other's waker. Dropping an operation
future while retaining the transport does not remove its stored waiter or an
assigned reservation. The production read/write loops await their operations;
Client::close aborts and joins both halves, dropping the encrypted transport and
all its waiters. The cancellation guarantee is transport cleanup, not arbitrary
operation cancellation with a retained transport. No parser waits for a fresh
payload grant, and scratch never competes with already-issued credit.

Pending handshakes count toward the existing 4,096 transport cap. They additionally reserve
4 MiB from the incoming pool before creating a rustls connection, plus 256 KiB
from the outgoing pool. The larger incoming charge conservatively covers
ClientHello vector/metadata amplification, not merely its encoded length. On
successful completion it shrinks to 256 KiB; that incoming charge and the 256 KiB
outgoing charge stay with the encrypted transport until both network tasks have
closed. Admission leaves one 64 KiB application window in each pool. Occupied
pools can therefore reject a TLS connection below the transport cap. With otherwise
empty pools at most six simultaneous handshakes are admitted; successful ones
return their scratch capacity. These conservative values require throughput
qualification before selection; they are not a claim of 4,096 simultaneous TLS
sessions within 32 MiB.

Pinned rustls 0.23.46 limits an individual handshake message to 65,535 bytes and
wire records to approximately 18 KiB. Its fixed ClientExtensions slots reject
known duplicate extensions; unknown-extension tracking and length-prefixed
vectors are bounded by that message length. With no client authentication,
there is no retained peer certificate chain. The encrypted input adapter also
limits the entire handshake to 256 KiB, retaining the counter over pending and
fragmented reads. After establishment it allows at most 1 MiB of encrypted
control-only input between delivered application reads. This deliberately
refuses pathological control/padding traffic rather than building a queue.
It resets only after application bytes are delivered, never on a partial TCP
read. Rustls additionally limits consecutive key updates to 32 and warnings to
four between application messages. `wants_read()` prevents another decrypted
record from accumulating while plaintext remains buffered.

The shared workspace also covers unexpected post-handshake messages. In pinned
rustls, payload decoding precedes the traffic-state rejection; therefore a small
established record-buffer charge alone is insufficient. The full decoder call
runs under shared scratch even when its result is an error. Decoded unexpected
message vectors are dropped before that synchronous call returns. Intermediate
initial-handshake state has not been assigned this smaller bound: it keeps its
own 4 MiB reservation throughout the handshake. No private vendor API or patch
is used to skip parsing or state checks.

Application output uses `set_buffer_limit(64 KiB)`. That setting alone does not
bound handshake/control output: the bounded certificate input, rustls state
machine/control limits and retained transport charges cover those separately.
Each installed PEM file is at most 64 KiB and must be regular; nonblocking open
refuses FIFO/device inputs before reading. At most two bind jobs exist at once.
An unbound configuration can remain shared by its established sessions, so
retained configurations are bounded by the transport cap plus two listeners,
not merely the listener count. Rustls' default session cache is bounded to 256
entries per configuration. Shared configuration/key/session-cache metadata, task/allocator
metadata and OS socket buffers are separate fixed/per-cap overhead, not payload
leases. These are logical storage bounds, not an exact RSS or kernel/disk-latency
promise. A Data packet retains its original lease until encrypted flush completes;
no plaintext acceptance is mistaken for a TCP-delivery receipt.

Handshakes have Node's default 120-second deadline. Unbind aborts that listener's
pending jobs; generation close aborts all and explicitly joins them. A completion
from an old listener epoch is dropped even if the same listener name is rebound.
The original generation shutdown deadline takes precedence. Established sessions
survive Unbind, as plain sessions do. No Abort/End/EOF or shutdown-receipt semantics
change here.

Material loading runs in a Tokio blocking job so disk/PEM work cannot block the
actor. Aborting/joining its async bind task cannot cancel a blocking job that
already started. That job can retain the opened file and bounded read buffers
until the OS read returns or the fixed installed service process exits. Joining
the bind task is not confirmation of material-reader cleanup. The outer process
termination and existing runtime shutdown policy remain the final boundary;
neither a hard disk-latency deadline nor a separately reaped reader is claimed.

The checked-in key/certificate are synthetic localhost-only test fixtures, never
instance credentials. Tests verify their chain and name at a fixed time within
that fixture's validity interval. No product trust bypass is used.
