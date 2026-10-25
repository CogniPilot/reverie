# Current-source Goal assembly — source only, activation HOLD

The optional `reverie web --goal-private-config /absolute/private/goals.json`
launcher constructs the singleton canonical Goal assembly. Omitting the option
leaves Goals unavailable; an explicit invalid or incomplete configuration refuses
startup. This source implements the normal private configuration reader and
launcher delivery. It does not initialize private state, provision trust, discover
credentials, reconcile migration or adopt existing sessions. See
[private bootstrap](goal-private-bootstrap.md) for the exact closed contract.

## Canonical authority and trusted mode

`WebServer.setupRoutes()` constructs `createGoalServerAssembly` using its actual
owner service and exact canonical CompanyStore filename. Authentication is passed
to the single `CompanyService.goals`; the actual CompanyService, session registry
and retirement service attach once. `GoalCanonicalAuthority` supplies current
binding and scoped actions. Custody, current owner/binding/action, generation,
CAS, revocation and final durable commit fences remain mandatory. Wrong filenames,
second attachment and mixed provisioning forms refuse.

Trusted private configuration and provisioning explicitly require `owner-only`
or `owner-and-employee`. Mode is not selected by a request header or failed proof.
The matching restricted broker's G operation supports only `owner-only`; it
refuses the other mode even though the shared schema recognizes it. Owner-only
accepts only genuine unrestricted primary-owner cookies. Invalid, mixed, service,
agent and present proof headers cannot fall back to owner authority. Employee
`authenticate` and `assertCurrent` permanently deny. No employee verifier or nonce
backend is constructed and no issuer/key-content/nonce authority call is made.
The complete private key metadata, canonical/nonce/lock/pending/authority namespace
and fresh custody checks are still required.

The matching `OfficeAPI` constructor has no Goal-signer argument. Reserved Goal
requests always refuse before credential reads or upstream forwarding, including
requests carrying a valid synthetic component proof. No original-worker observer,
NEW-launch Goal pin, employee signer, generation adoption or runtime writer is
installed. Standalone signing/pinning components do not establish employee delivery.
Employee original-program observation and signer delivery require separate reviewed
source work; they are not enabled by changing the mode value.

The low-level `GoalServerPorts` trusted in-process seam remains for compatible
embedding and isolated tests. It is not an HTTP/config callback interface or
implicit enablement. See [server integration](goal-server-integration.md).

The accepted metadata-only health provider is composed against the same canonical
store and registry. Its purpose-scoped reader remains separate from active Goal
authorization; it does not replace current binding/action checks or manufacture
FROZEN evidence, recovery or process telemetry.

## What the evidence exercises

| Controls                                              | Actual scope and limits                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner-only/private launcher                           | Actual restricted G/OfficeAPI boundary and genuine fixture-owner cookies, canonical CRUD/metadata, durability, current generation, privacy and after-sync commit fences. Engine inventory, executable ownership and private namespaces are owned synthetic fixtures, not installed custody proof.                         |
| Combined server and retained transport/auth positives | Explicit test-only `--component-proof` invokes unchanged `GoalRequestSigner`/header codec with synthetic key, binding, clock and transport. Real client serialization, HMAC/provenance, nonce and canonical adapters are exercised where used. This does not cross a working OfficeAPI signer or prove employee delivery. |
| Restricted Office/default-unavailable negatives       | Actual OfficeAPI refuses canonical and malformed Goal paths without credential reads/upstream forwarding, even with a valid synthetic proof. Absent server adapters deny a supplied synthetic proof with403. No expectation is weakened to accept a missing proof.                                                        |
| Logical configuration OFF                             | Same schema-capable source, config omitted on actual launcher construction and normal authenticated canonical writes preserve populated Goal/generation/nonce state. This is not a full startup, image fallback or production rollback test.                                                                              |

Sessions in component fixtures are real unstarted Session objects in an owned
registry; no start/PTY/model call or real worker liveness is proven. Existing
canonical privacy/replay/revocation and migration fences remain required. Source
component passes and author checks do not replace independent combined review.

## Remaining release and operator gates

The exact current-source composition must preserve later website changes, pass
native/image/mounted-root acceptance and receive installed identity/config/volume
receipts. Real operator provisioning must establish the pinned immutable helper,
explicit engine/server context, complete actual mount/exposure inventory, private
config/key/nonce custody and durable restart behavior. Real-engine latency under
the unchanged10s proof lifetime remains unproven; source fixtures do not establish
production headroom. An authorized bounded owner canary follows those gates.

Rollback must use separately accepted schema-capable source with adapters OFF and
reuse every existing canonical/private volume. Old0b3 drops new Goal/generation
metadata on ordinary writes and is not a safe rollback after Goal writes. Do not
restore whole pre-Goal state, reset ledgers or drop unknown metadata. Logical
same-source OFF evidence alone grants no image or activation approval.

No host/image/configuration action, real key read, employee signing, deployment,
execution, wake, delegation, model or recovery effect is authorized by this source
packet. Installed continuity and production rollback remain HOLD.
