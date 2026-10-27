# Goal private bootstrap — source implementation, activation HOLD

The ordinary `reverie web --goal-private-config /absolute/private/goals.json`
path now constructs the real singleton canonical Goal assembly. Daemon and service
argv forwarding retain that explicit option. Omission leaves Goals unavailable;
an explicit incomplete or invalid configuration refuses startup. This is not an
activation approval. No initializer, default issuer/key/grant, trust discovery,
worker-header authority, automatic migration reconciliation or recovery adoption
is supplied.

The existing operator-private worker configuration must explicitly select the
same host configuration using `goalPrivateConfig`. The strict version-1 JSON has
only `version`, `mode`, `issuer`, `epoch`, `serverContainerId`, `paths`, `nonce`, `server`:

- `mode`: exactly `owner-only` or `owner-and-employee`, explicitly selected in
  trusted private provisioning, not HTTP headers, environment discovery or failed
  proof fallback. Missing/unknown modes refuse. The same closed field and digest
  are checked by the server and broker. Changing it requires an explicit restart.
- `issuer` and `epoch`: existing operator-selected ASCII identifiers (1–64).
- `serverContainerId`: the exact current 64-hex engine container identity.
- `paths`: exactly `config`, `key`, `canonical`, `nonce`, `authority`; each has
  explicit absolute normalized `host` and `server` paths. Canonical is the EXISTING
  CompanyStore file, not a new Goal/employee/grant authority store. Key is exactly
  32 private bytes outside the Nix store. Authority is a private directory.
- `nonce`: explicit existing `storeId` UUID, `capacity` (1–4096), and absolute
  trusted packaged `flockExecutable`. Ledger and lock must already be valid and
  durably provisioned; missing files never initialize themselves.
- `server`: exact existing `brokerSocket` server path and operator-pinned
  `custodyClient` (`reverie-worker-exec`). Its resolved packaged executable must
  be root-owned, non-group/world-writable, executable, inside `/nix/store`.
  `REVERIE_WORKER_SOCKET` must already name that same endpoint.

Private file/parent modes, hardlink/symlink/nonregular refusal and anchored FD
identity checks are necessary, NOT sufficient custody. Each check obtains a NEW
closed `G` projection over the existing broker transport. The broker uses actual
SO_PEERCRED UID plus the pinned running server's current mount namespace, complete
configured and actual engine mounts (including read-only aliases), exact bind
path mappings and whole canonical/nonce/trust/authority/control namespaces. The
projection contains only a config digest and 14 closed inode/metadata tuples—no
credentials, objectives, profile text, arbitrary command/path or engine proxy.

A bounded persistent helper/thread/pipe channel avoids launching an interpreter
per check. It stores no authority projection. Every call still repeats current
inspection and anchored path checks; per-projection batched descriptors are
closed immediately. Helper, endpoint, config or key identity drift, malformed or
oversized output, timeout, inaccessible engine or ambiguity refuses. A failed
channel requires explicit server restart, not automatic trust repair. Server stop
and failed startup release the helper channel. Single broker engine call bound is
0.5s/1MiB, inventory bound is 1.5s/64 containers, helper socket roundtrip is 1.75s,
helper-thread response is 2s and the server's total wait is 2.5s/32768 bytes. The
existing assertion lifetime remains 10s and is rechecked after blocking I/O.

The matching restricted broker is carried as one unit with `worker_cleanup.py`,
`goal_bootstrap.py` and `goal_custody_client.py`; see [Owner-only broker custody](goal-owner-broker.md).
Its G operation accepts only explicitly configured `owner-only` mode. Although
the shared schema recognizes `owner-and-employee`, that mode is unsupported by
this broker and refuses. OfficeAPI never installs a Goal signer under either
mode; reserved Goal requests are refused before upstream forwarding or credential
reads. It does not add NEW-launch Goal pins, employee signing, runtime writers,
generation adoption or a trusted original-program observer. Existing worker
terminal/launch behavior remains the restricted broker's reviewed implementation.

Standalone bootstrap pinning/signing components and their negative-only durable
`goalProgramClosed` floor remain in source and component controls. Their synthetic
exact-program observer is not wired into Broker.office and does not attest a real
host program. The proof-component test mode supplies synthetic key/binding/clock
explicitly to exercise the unchanged server HMAC/nonce/canonical controls; it is
not a supported employee transport. Current owner launcher tests use the actual
restricted G/OfficeAPI boundary and genuine fixture-owner cookies. Recovery and
reconnect cannot mint or adopt employee Goal authority. The singleton's real
canonical action/grant/current-owner adapters and commit fences remain active.

## Owner-only durable stage

`owner-only` permits only genuine unrestricted primary-owner cookies. The real
cookie service, same-origin mutation checks, current canonical binding/action,
revocation, generation, CAS/replay and final atomic-commit fences remain active.
Limited/admin/keeper cookies, Basic, service and parent-session credentials and
any present Goal proof/header cannot fall back to owner authority, including a
cryptographically valid employee proof alongside a genuine owner cookie.
The employee adapter's authenticate and assertCurrent permanently deny; no
employee verifier or nonce backend is constructed. Its issuer is never consulted,
and the normal broker refuses signer construction before private key content.
There is no original-worker observer substitute, new grant or automatic recovery.

Owner-only retains the COMPLETE private config/key metadata/canonical/nonce/
lock/pending/authority namespace and fresh custody projection, root-owned pinned
helper, exact engine/server context and exposure refusal. It does not omit the
nonce namespace or key metadata because employees are disabled. No stale custody
cache, expiry increase or per-I/O guard change is included. This source stage is
useful for durable owner API create/read/transition/adopt/grant/proof/metadata;
there is no generic DELETE endpoint or new Goal UI in this change.

### Schema-compatible rollback is mandatory: activation HOLD

The old live website base does not preserve these Goal arrays and employee
session-generation fields. **Never roll data back to that image after any Goal
write**, and never restore a whole pre-Goal company backup to erase metadata.
A prospective rollback must use the exact schema-capable successor with Goal
provisioning OMITTED (adapters default-denied), preserving the SAME CompanyStore,
owner state and every private Goal/nonce/lock/config/key/authority volume. No
initializer, truncation or metadata dropping is allowed. The owner-only launch
fixture exercises restart into that OFF source and an ordinary canonical write,
then back into owner-only with the existing data and untouched nonce ledger.
This is a SOURCE compatibility witness only. Separate independent review of the
exact rollback source and its native/image/mounted-root acceptance, plus current
operator identity/config/volume receipts, remain HOLD. No image, host action,
configuration, provisioning or live Goal write is performed by this packet.

## Blocking operator/release gates

**EMPLOYEE B2 FUNCTIONAL/DEPLOYMENT HOLD (not an owner-only observer prerequisite):** a separately reviewed NEW-launch seam must
obtain a trusted handle/engine-owned exec incarnation for the ORIGINAL program
before issuing a signer, durably bind that identity in the existing runtime.json,
recheck current state and exact owner/session/generation after blocking work and
before sign, and retain monotonic completion across exit-file removal and broker
restart. It must never adopt a replacement from a reconnect, mutable tmux pane,
request, maintenance generation or absent exit file. This packet does not
overhaul terminal launch or implement that unavailable observer.

Private custody refuses configured GPU/CDI grants and inspected unsupported
runtime/device/capability/namespace/security expansion, including stopped
containers. Mounts alone does not inventory hooks or CDI expansion. No actual
GPU/device/engine change or acceptance is implied.

HOLD: real-engine latency is unproven and the current repeated inventory call
graph is expensive. A retained diagnostic observed **422 cumulative fresh
projections through bootstrap and the first synthetic create** (one bootstrap
projection; the rest were the create). Counts vary with clock-floor writes:
nonce per-I/O guards plus auth/current-binding/action/core commit fences each call
the private projection, which currently runs `docker ps` and `docker inspect`.
The helper optimization does not remove those engine subprocesses. Synthetic
inventory passing inside the unchanged assertion lifetime is NOT production
usability. Separately review an invariant-preserving optimization: fresh entry
and pre-effect custody plus fast anchored local per-I/O checks, or a CLOSED fresh
inventory transport in the existing engine context. No TTL increase, stale
authority cache or new broad engine proxy is approved by this source.

The rootless development store does not satisfy the root-owned packaged-helper
contract. Fixture executable metadata/engine inventory are explicitly synthetic.
An operator must attest actual installed helper path/digest/mode/owner, exact
image/server/container mapping, all actual mount scopes, private config/key/nonce
custody, durable nonce restart behavior, current canonical/runtime pins and the
ordinary real-engine canary under the unchanged proof lifetime. Any service-owned
rootless-package acceptance rule needs its OWN reviewed immutable-current-image
evidence; same UID or mode bits alone are not accepted. No such attestation,
provisioning, key/grant creation, existing-session adoption, build, live API/model
call or activation was performed here.

Current deployed UI/appearance/routine successors must be contextually composed
and reviewed separately; this branch preserves its sealed predecessor. The accepted metadata-only health implementation is preserved byte for byte.
Its purpose-scoped reader remains separate from active Goal authorization; no
mutable health selector replaces canonical binding/action checks. Full Nix/image and mounted-root acceptance
remain separate gates. The console derivation now explicitly supplies the trusted
Python and two offline bridge fixture sources (including the explicit proof-component test mode) under test/fixtures/goal-source;
named Goal tests use that fixed source locator and the owned native TMPDIR rather
than an assumed repository parent or /scratch/tmp. Flattened native-source tests
are not an actual Nix/image build or packaged-helper ownership acceptance.
