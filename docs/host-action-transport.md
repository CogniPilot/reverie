# Private host-action transport

This slice adds an authenticated, bounded Unix HTTP adapter for the owner-approved
queue. It is disabled by default: the worker broker accepts an optional injected
host-action callback, but its normal configuration does not create that callback.
There is no service activation, owner approval page or privileged helper in this
slice. Requests cannot execute actions through this transport.

## Identities and custody

Two different host-only signing keys separate request/read operations from owner
decisions. Both keys, the queue database and the host-action socket must live in
private host-owned storage outside every laptop, shared workspace, project and
scratch mount. Socket parents must be private, owned, absolute and free of symlink
components; existing socket paths are never stolen. An explicit peer-UID allowlist
is checked on each connection. None of this grants host access to laptop root.

A laptop uses its existing session-scoped office socket for GET or POST
`/api/host-actions`, or GET `/api/host-actions/<request-id>`. That proxy derives
requester identity from the socket's fixed session, ignoring forged headers or
body claims. Approval paths, query parameters and extra request fields refuse.
It signs only request/read methods; the laptop never gets a signing key, the host
socket, an engine socket, or an owner credential. Ordinary office requests retain
their current behavior. If no host callback is configured, these paths return 503.

The website's eventual owner route must authenticate an unrestricted owner
session with same-origin mutation protection before using the separate owner key.
Parent-session headers and service credentials cannot authorize approval. That
route is not wired by this slice. A host-owned requester signer is trusted to bind
its subject correctly; the HMAC does not independently authenticate laptop JSON.

## Envelope and response

The single endpoint is POST `/v1/host-actions`. Canonical JSON carries version 1,
integer issuedAt, a UUID nonce, method, authenticated subject, and exact method
parameters. Signatures use HMAC-SHA256 over the exact body. Envelopes outside a
30-second clock window refuse. Durable nonces prevent replay across service
reconstruction; they are retained beyond the permitted clock window. Methods are
only request, get, list and decide; there is no run, shell, arbitrary URL or engine
proxy. Approval remains tied to the original request, target digest and expiry.
The queue's claimed-execution and uncertain/no-retry semantics are unchanged.

Requests are capped at 16 KiB and responses at 64 KiB. A single absolute
monotonic five-second budget covers request parsing and client response IO,
including buffered reads; a slow drip cannot renew it. Expiry only ends transport
IO: a queue operation already dispatched is not cancelled or automatically retried.
Malformed byte encodings are sanitized as unconfirmed responses.
There are at most eight concurrent transport handlers. Lists are requester-scoped
unless signed by the owner, limited to fifty records and 48 KiB of encoded receipt
data. More receipts can be fetched by exact ID. Responses never expose raw host
exceptions. Explicit HTTP refusals are separate from missing/malformed/failed
responses, which are unconfirmed and never automatically retried.

## Next integration and acceptance

Before enabling this adapter: validate host key/storage locations against all
actual laptop grants, connect the fixed requester signer on the host, add the
verified-owner approval UI, implement the narrowly privileged pool helper with
approval-deadline enforcement, and package the private services in the project
flake. Preserve existing broker policy and active transports while installing.
Then independently review the complete chain and exercise a real owner-approved
canary with rollback. Pure tests and temporary Unix sockets are not deployment
or engine acceptance. No host change is authorized by merging this source.
