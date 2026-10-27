# Packaged owner-terminal core components

Source only. No installed issuer, permission, route, H operation, PTY, shell,
service, provider/laptop action or production ledger write. The fixture's owner
cookie, company identities and native observations are synthetic and never come
from a personal instance. The accepted authority, protocol, native channel, bootstrap and connector
remain byte-identical. The ledger and host adapter change only their imports
to support the canonical Python package and the retained fixed flat bundle.
Source provenance is listed below.

## Fixed composition and API

The host receives the already admitted **R2 Handoff** object. It constructs:

```python
service = LedgerService(admitted_channel, installed_private_ledger_directory,
    native_target=fixed_native_target, consumer_verifier=fixed_broker_peer)
```

`native_target.observe(employeeId)` must synchronously return the ten exact
accepted protocol CURRENT_KEYS, freshly produced from canonical owner intent,
explicit terminal entitlement, exact EID/SID/generation and native engine full
CID/image/policy. Missing observation refuses before ledger open; role/title,
wire flags or company metadata alone cannot replace native identity.

`fixed_broker_peer.assert_current_peer(consumerDigest)` must return None after
independent actual broker process/service/descriptor verification, or raise.
It is the unchanged ledger's mandatory consumer check, never a wire digest
comparison alone. Omission leaves consume/recheck unavailable. This candidate
does not implement that future H actor or infer it from the shared-UID J socket.

The fixed website early entrypoint first calls the accepted R2 connection helper
and then supplies the resulting paused socket plus the **actual accepted
OwnerLaptopTerminalAuthority instance** to:

```ts
const bridge = new OwnerLedgerBridge(admittedPausedSocket, actualAuthority);
const publicReference = await bridge.issue(actualOwnerRequest, employeeId, cols, rows, 300);
const metadata = await bridge.metadata(actualOwnerRequest, publicReference.authorizationRef);
await bridge.metadata(actualOwnerRequest, publicReference.authorizationRef, true); // revoke
```

No route is added here. A future route must use the existing unconditional owner
verification, exact trusted Origin/ingress, same-session tracking and cancellation
requirements. `issue` invokes the real class's `capture` itself; there is no API
to register a claimed context/digest/owner flag. Every operation and host challenge
rechecks its captured private context against the actual live backend session.
The constructor does NOT provide a fake `protectedChannel.assertCurrent`, owner
verifier, ingress attestation or native observer. Absent accepted Authority ports
continue to refuse. Tests provide those controlled ports and label that boundary.

Only `{shellId, authorizationRef, expiresAtEpochMs}` is returned from issue.
The entire protocol request and secret proof remain in private backend/host
memory; ledger disk stores the proof hash as before. No method logs a token or
returns it from status/error. Bridge JSON conversion refuses and inspection is
redacted. No browser cookie/password/JWT reaches Python, argv, environment or
wire. Dropping JS strings is not a memory-zeroization guarantee.

## Serialized wire contract

One event-loop thread owns host I/O and ledger calls. There is one pending Node
command, no unbounded queue. Readiness-select the channel before calling
`serve_once`; the five-second budget applies to an operation, not idle service
polling. Do not run a concurrent background reader or block the Node event loop.
Each frame is uint32 big-endian length plus 1..8192 bytes of canonical compact
JSON. Existing strict Python protocol decoding bounds duplicate keys, depth and
integers; round-trip canonical checks reject duplicates/noncanonical JSON at both
ends. Noncanonical, oversized, truncated, replayed and unknown frames terminate
the channel. Kernel peer/pidfd/incarnation and per-message credentials remain
mandatory around I/O through the accepted Handoff.

Closed Node command fields:

- `{kind:'command', n, operationId, action:'issue', handle, employeeId, cols, rows, lifetimeSeconds}`
- `{kind:'command', n, operationId, action:'status'|'revoke', handle, employeeId, reference}`

`n` starts at1 and increases once per operation, max1024. `operationId` and
`handle` are backend UUIDs; the latter names a private captured context. There is
no consume/recheck/command/filepath/provider operation on this owner wire.

Every ledger owner/target guard asks the SAME authenticated backend channel:

```text
{kind:'authority-check',n,operationId,handle,challenge}
{kind:'authority',n,operationId,handle,challenge,scopeDigest,expiresAtEpochMs,target}
  or {kind:'authority-refused',n,operationId,handle,challenge}
```

The challenge is fresh, bound to the exact operation/context and never reusable.
The backend finds its privately registered Authority context and awaits its
`recheck`; it never converts wire owner=true into authority. The host also compares
the entire returned target with its independently fixed native observer. Scope,
target and absolute expiry must remain identical across checks. A returned digest
alone is NOT authentication; actual admitted backend code plus fresh real Authority
recheck and independent native target are required. The capability expiry leaves
the full bounded operation budget inside the backend scope's absolute lifetime.
No recheck renews owner scope or capability lifetime. The unchanged accepted
Authority defaults to a 60-second context lifetime: this bridge reserves the full
five-second operation budget plus elapsed/rounding time, so the default issued
TTL is less than 55 seconds even when the request asks for 300 seconds. A future
trusted composition may explicitly select the accepted `contextLifetimeMs`
constructor option within its existing bounds; this candidate does not change
that default or silently extend any captured scope.

Result: `{kind:'result',n,operationId,state:'ok'|'refused'|'unconfirmed',value}`.
Known refusal has null value and can permit a new explicit owner request. A
commit-uncertain or lost/malformed/EOF response has no success proof, closes the
channel and latches no-retry. It may have created a ledger record; never claim
no effect or automatically reissue it. Raw exceptions/response bodies are not
returned as errors. Explicit owner status/revoke still uses the unchanged ledger.

## Future trusted consumer port, without an H implementation

On that SAME serialized host event loop, outside any concurrent `serve_once`:

```python
capability = service.for_consumer(reference, independently_verified_consumer_digest)
channel = human_terminal_protocol.Channel(capability.request,
    fixed_native_target.observe(employee_id), capability=capability)
```

The existing LedgerCapability performs one durable consume and current
owner/native/peer rechecks. A new shim cannot consume an already consumed record.
No process is spawned by this adapter or by the logical protocol Channel.
Consumer guards use n=0, a fresh operation UUID and the already private context
handle. Node accepts these only while its owner-command path is idle. A collision
or unexpected interleaving fails closed; **the future H actor must supply the
single serialized scheduling/admission discipline** rather than assuming parallel
owner and consumer I/O is supported. This matches the accepted protocol's existing
serialized-event-loop requirement; concurrent native H traffic is not qualified.
A refused reentrant/wrong-thread consumer call latches that consumer only. It
never clears an owner operation it did not acquire; cleanup compares the exact
per-call operation object before releasing its own guard.

## Exact installer/native gates still missing

The transport candidate is not installed custody. Before production construction:

1. Fixed Nix-built ordinary-owner user service/launcher, immutable Python/Node
   executable+argv and reviewed image. Reject Node/loader injection controls.
2. Bind current engine identity/socket and exact website CID/image/init PID/start,
   full Config **AND full HostConfig plus complete Mounts**, namespace/ancestry and
   immutable entrypoint. R2's process verifier currently binds Config; the installer
   must independently enforce HostConfig/mount policy, not call it already proved.
3. Dedicated listener/ledger directories outside ALL configured/live worker grants,
   ancestors, physical/nested mount aliases, private homes/Nix/workspace/scratch
   and other exposed paths. Only bootstrap directory is mounted read-only into
   the website; ledger never is. A fixture0700 directory is not this evidence.
4. Actual two-phase Python CLOEXEC -> same PID/start exec -> fresh Node connection,
   single listener retirement and no reconnect. No shared UID, bearer cookie,
   arbitrary argv/env proof or external JWT substitute.
5. Genuine native target/explicit entitlement and protected broker-consumer peer
   producers, logout/owner-session/shutdown closure and cancelled-route handling.
   On backend loss/restart all its scopes become unavailable; no automatic replay.
6. Existing accepted components are not canonical-package promotions in this
   task. A fixed flat immutable Python bundle preserves their accepted sibling
   imports; the TS adapter compiles beside the accepted Authority module. Packaging,
   installation and actual owner browser/native acceptance remain separate.

## Verification

`bridge.close()` is the explicit fail-closed cancellation/shutdown hook. During
an issued operation it yields unconfirmed, never rollback/no-effect success. A
future route must bind actual server cancellation/loss to this hook; no browser
JSON cancellation claim is trusted. This terminates the one-use channel and its
contexts. Normal post-issue human-shell close/reap remains the future H actor's
responsibility; this adapter does not claim process settlement.

Strict native-flake TypeScript compile and17 composed owned tests pass. Tests use
real Python->Node exec/sockets, SO_PEERCRED/pidfd/SCM_CREDENTIALS through R2 Handoff,
the REAL accepted TS Authority with controlled session/ingress/native ports,
the REAL ledger files/commit guards and the REAL logical protocol. Engine binding
and installation observations are explicitly fixture ports, not native custody.
Cases cover public proof separation, exact consume/recheck, owner logout before
issue and during consumed use, independent CID drift, owner loss after durable
commit, real Authority shutdown, duplicate/replayed command, lost success ACK,
forged owner/digest fields, oversize/truncated EOF, owner metadata/revocation,
and actual overlapping/wrong-thread consumer refusal during a live owner issue
with byte/inode/IO/commit and active-object preservation.
No accepted baseline suites, model calls, real credentials, host engine, PTY,
provider, current thread or installed source were changed.

## Canonical package and checks

The shared Python modules are in `python/reverie/`. Canonical package imports
use relative dependencies; fixed flat immutable bundles retain standalone
imports. The only promotion changes to the accepted Python behavior are those
import choices. `OwnerLaptopTerminalAuthority` and `OwnerLedgerBridge` are normal
console TypeScript modules, with no server import/route/startup activation.
The reviewed connector is `apps/web/scripts/connect-owner-terminal.mjs`.

`nix build .#ownerTerminalCore` packages five inert Python modules, the connector
and TS source with these integration notes. It has no executable/service or
console dependency and performs only import/syntax checks. The normal console
build compiles the TS modules and its check phase runs the17 composed owned
Python/Node tests after compilation. Those tests are outside generic Python
discovery; generic Python package checks require no console build. This avoids a
Python-suite/console derivation cycle. Neither check invokes a host engine,
provider, private instance, native H actor, PTY or installed listener.

Native development uses `PYTHONPATH=python` for generic tests. To run the dedicated
composition after building the two TS modules, set `OWN_TEST_NODE` to the actual
Nix Node executable and optional `OWNER_TERMINAL_TEST_DIST` to that compiled
directory, then run `apps/web/test/fixtures/owner-terminal/test_bridge.py`. Its
engine/owner-session observations remain explicit owned fixtures. No test or
package declaration qualifies installed mount/grant custody or opens a user
terminal. All installer/HostConfig/Mounts/consumer-peer/entitlement/H scheduling
and live owner/native acceptance gates above remain open.

## Source provenance

Accepted shared R2 manifest: `066feebe068ec08bc94d32a689be91a23a53bb8ab8efffbf9270fbc2b62b220a`.
Only Python dependency-import wiring differs from these accepted product files.
No private runtime/provenance paths are part of this source projection.

| Canonical file | Accepted SHA256 | Promotion |
|---|---|---|
| `python/reverie/human_shell_capabilities.py` | `d5326b27f3f15416d2e8d5f0b67b0a24d5f3769da8c86ca9fcc76613ab1149dd` | package/flat imports only |
| `python/reverie/human_terminal_protocol.py` | `40f43411216972b5e725da0e37917f1b697a2e9c5f25439c3fb04a7332753490` | byte-identical |
| `python/reverie/owner_terminal_bootstrap.py` | `56ccc4afd74caef1f262ad65ef1eeefa33a1646b730c13015304b85738cc4d02` | byte-identical |
| `python/reverie/owner_terminal_channel.py` | `f0927660d3990ef64ef9a3ac3fec02e5b27c0d0f3162e166ba5a8247d1f18ab5` | byte-identical |
| `python/reverie/owner_terminal_ledger_service.py` | `5fab9f982b397faa80d7db5f69982f794bf1cdd96d5c60f74a1ba53d4387af6c` | package/flat imports only |
| `apps/web/src/owner-laptop-terminal-authority.ts` | `050d233c64b668573a25d3b9a5021e143ef84f2f92fbacbc1e5b81c1f76805b1` | byte-identical |
| `apps/web/src/owner-ledger-bridge.ts` | `74d0aa4b01d21b30c1cff3aae99a46cca01637e81274f96d131a1cdabea30fae` | byte-identical |
| `apps/web/scripts/connect-owner-terminal.mjs` | `45cf6b53afd06c0e8bb07c162faecb522eff2c284f1a602674018f5791110900` | byte-identical |
