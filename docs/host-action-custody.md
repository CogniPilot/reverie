# Host action signing-key custody

The optional `host_action_custody.load_key` primitive reads a single raw
32-byte signing key. It is not wired to a daemon, worker configuration or web
server. The host service must provide an authoritative inventory of every
laptop bind source, including engine-inspected running and stopped containers,
configured shared mounts, homes, scratch and provider account mounts. Read-only
mounts expose credentials too. Missing inventory refuses; supplying an incomplete
inventory cannot establish custody.

Both lexical paths and resolved aliases are checked for overlap. Key files and
parent components are opened through anchored directory descriptors without
following symlinks. The immediate directory and file must be private and owned
by the service; hardlinks, nonregular files and unexpected lengths refuse.
Ancestors must be root/service owned and not writable by other users, apart from
root-owned sticky temporary directories. Package-store secrets refuse. Key bytes
and underlying exception details must never enter API responses or logs.

The service integration must serialize inventory validation and key loading
against mount-grant changes, and reject grants exposing control directories
before engine creation. Startup validation alone cannot prevent later grants.
The existing worker broker remains the sole launcher. This primitive does not
move, rotate or delete any live key, nor does it prove the current host satisfies
custody. Request and owner keys must remain separate, and the root helper must
use a separate host-authenticated interface.

Remaining helper/service integration requirements:

- Host-only service credentials and sockets outside all exposed roots; no engine
  or administrative socket in a laptop. The web owner signer receives only its
  separate owner credential through a trusted host-selected path.
- A fixed helper protocol authenticates the service identity; no caller-selected
  command, unit, filesystem path or resource values. The only mutable pool policy
  is the separately reviewed fixed policy. Inspect-before-effect and approval
  expiry checks must occur again inside that helper, immediately before effect.
- Pool verification must bind the actual systemd slice/cgroup path. Runtime-only
  application must preserve a rollback snapshot and refuse concurrent policy
  changes. An uncertain reply never retries the effect automatically.
- Packaging remains opt-in/default-disabled. The canary must prove real peer
  identity, root-laptop denial, all mounts excluded, queue durability, duplicate
  suppression, expiry, policy proof and rollback with one explicitly approved
  laptop before broader owner activation.

These are integration gates, not claims that the helper or service exists yet.
