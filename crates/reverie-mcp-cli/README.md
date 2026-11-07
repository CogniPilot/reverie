# Installed MCP candidate

`reverie-mcp` is a fixed Rust entry into the existing TypeScript MCP server.
The top package owns the console and native memory packages, binds canonical
Node, raw TypeScript entry and native memory executable paths at build time,
and executes Node directly. The console has no dependency back on this package.
There is no request, PATH, environment or Python fallback for executable choice.
`--help` performs no bootstrap or memory read.

The optional `/run/reverie/memory-context.json` is installation DATA: a separate
instance reference, the existing instance ID, observed employee binding,
guest-interpreted configuration codepoints and configured resource selectors.
The launcher observes and checked-closes that fixed file before exec. The native
memory child rereads it and compares its exact fingerprint before selecting data.
Configuration paths do not pass through JavaScript strings or command arguments.
Metadata/codepoint decoding, a fingerprint, inode, lease, ready marker, title or
executable custody grants no permission and proves no process attestation.

Installed memory reads ask the actual fixed-session Office API at
`POST /api/agent/memory-scope` before and after reading history. That route uses
the existing current employee and owner-issued `ServiceGrant` authority, checks
revocation and canonical policy generation, and withholds results after a policy
change. The route re-observes the actual live caller after durable nonce I/O,
matching the detached request binding rather than a mutable employee reference.
Host issuer keys stay in the protected server composition. The Office
phone supplies its constructor-bound parent session and host Basic credentials;
the employee receives no global service credential or signer. The response
contains selection/policy metadata only, with no configuration path or program.

The existing installer-owned service-authentication bootstrap may optionally
describe memory instance references, unchanged instance IDs, resource selectors
and exact guest configuration path codepoints. No mapping means disabled. It is
not a second grant store: the existing owner setup GUI and service-grant API issue
and revoke permission. One memory grant must name one employee and resources
from one explicitly installed instance, avoiding Cartesian employee/resource
interpretation. Multiple existing instances may retain the same `default` ID;
their deployment references distinguish them without resetting any data.
The existing instance `employee_id` remains parsed metadata in a different
identity domain. It neither grants access nor overrides an explicit owner grant
to a current Company employee with an opaque ID.
Installation data is provisioned through the typed one-time installer bootstrap,
not by a deployment script or by directing operators to edit private files.

The MCP journal remains the authenticated Office journal, in process. A memory
read grant does not authorize a journal write. The native child gets only its
selected model/proxy/settings fields, without journal credentials. Existing
standalone opt-in instances remain available without an installed context, and
no opt-in/context leaves memory tools disabled. Read-only recall does not
initialize, import, reembed, rewrite profiles or seed an existing database.

Cancellation reaches journal/API requests and the actual bridge child. Shutdown
waits for real request completion and child `close`, including after an early
`execFile` abort callback. A retained child gets one SIGKILL escalation after its
initial cancellation; a missing close remains pending. Ordinary timeout and
per-stream output overflow arm cleanup independently of the completion callback,
so a child ignoring SIGTERM cannot prevent the escalation attempt. A later abort
does not renew the first cleanup budget. A timed-out result is refused even if
the cooperative child exits zero. Final acceptance rechecks the original monotonic
deadline even when event-loop delay postpones its timer callback. No result from
a cancelled call is emitted.
The MCP process awaits settlement before exit.
The fixed installed entry intentionally omits diagnostic logging so a full
stderr stream cannot retain an idle Node process. Protocol and error responses
still use stdout; ordinary standalone MCP logging is unchanged. Rust launcher
errors before exec use the existing bounded diagnostic owner.

## Selection holds

This source is an unselected integration candidate. The real installation and
canonical launch/recovery owner must publish and mount the reviewed context
read-only and retain its lifetime with the actual Office phone. No accepted
producer is inferred from a storage claim, company ID, session label or argv.
The protected bootstrap mapping does not itself perform that publication.

Guest executable custody also needs actual qualification. An employee's writable
private `/nix` store cannot supply the root-owned immutable origin required here;
host package validation does not prove guest ownership. A fixed immutable guest
artifact and its loader/library provenance must be joined to the real image and
launch producer without weakening custody checks. Origin remains DATA rather
than authentication, including for arbitrary processes using injected loaders.

Arbitrary existing Python output-policy regex compatibility, actual installed
namespace/UID producer qualification and final consumer selection remain separate
requirements. This package introduces no restricted regex substitute and retires
no active legacy selector based solely on library or synthetic API tests.

The optional actual namespace qualification uses only a fresh synthetic root,
private user/mount/PID namespaces, synthetic account files and readonly public
Nix artifacts. It explicitly initializes fixture data before the read and checks
unchanged database, profile and configuration bytes. This is not qualification of
an OCI image, a real guest UID map or the missing launch context producer.
