# Owner-approved host actions

The proposed executor lets an authenticated expert request a named operation and
lets the owner approve its exact target once. It is separate from terminal tools:
there is no shell, arbitrary command, argument list, environment or path in the
request schema. The initial operations are `stop-laptop` with a canonical session
ID, `verify-runtime-pool`, and `apply-runtime-pool`.

The implementation is currently an unconnected source prototype. It has a durable
queue and fixed target adapters; it does not yet expose a network route, approval
button, privileged helper or deployed service.

## Approval and execution

The office derives the requester from authenticated session identity. It asks the
host service for a nonsecret preview: the exact deployment/session/container ID,
or the managed runtime unit and policy digest. The owner sees that preview,
requester, expiry and effect. An owner-authenticated POST approves or rejects that
request ID and digest; agent and service credentials cannot approve it. Approval
expires after five minutes, including while waiting to execute. The host carries
that deadline through target resolution and the fixed handler's second preflight,
checking it immediately before an effect begins. Nested privileged helpers must
carry the same deadline to their own effect boundary. Expiry before any effect
refuses the action; expiry after a partial effect is unconfirmed and never retried.

The host atomically claims approved work before acting. It resolves the target
again and refuses a changed container or unit. Stops use only the immutable
container ID. A timeout, lost response or interrupted executing request becomes
`unconfirmed`; it never causes an automatic second stop or apply. Verify reality
before requesting another approval. A receipt reports pending, approved, denied,
executing, succeeded, failed or unconfirmed without raw subprocess diagnostics.

The pool operation applies only an owner-selected, reviewed runtime slice policy.
It cannot edit broker configuration, restart the website, migrate laptops, change
the watchdog or edit an operating-system repository. Those require separate
reviewed operations. The temporary runtime unit disappears after host reboot.

## Remaining integration gates

The queue and audit database must be in a private host-owned directory outside all
shared workspace, project and scratch mounts. The website-to-host transport needs
peer authentication and replay protection; requester/owner fields come from that
trusted adapter, never directly from a laptop JSON body. The injected Principal
class in the prototype is an internal value, not network authentication.

Use the verified owner-account boundary for approval, enforce same-origin/CSRF
protection, and reject service/agent/parent-header elevation. The owner-route
principal fix must be integrated before this approval API can be activated.
Bind every signed approval to request ID, digest, expiry and host policy generation.
The website may display action status but must not return host credential files,
engine sockets, private download links or arbitrary engine output to a laptop.

The ordinary host service can stop the selected deployment's laptop. Slice changes
need a separate privileged helper that accepts only the reviewed fixed operation;
never a general sudo or engine proxy. Package both services and their activation,
verification and rollback commands through the project flake. No imports or edits
to an owner's separate system configuration repository are required.

Before activation: independently review the complete request/approval/host chain,
exercise owner-versus-agent denial and replay tests, inspect final outgoing text
and metadata, and run a real host canary with rollback retained. The current pure
and injected-engine tests do not establish those deployment properties.
