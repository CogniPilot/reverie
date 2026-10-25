# Goal server integration — source only

This page describes the lower-level composition boundary and its current normal
launcher. Historical `GoalServerPorts` injection is a trusted in-process embedding
and test seam. The current constructor/factory accepts `GoalServerInput`, including
canonical provisioning supplied by the optional private-config launcher. See
[current assembly](goal-current-assembly.md) and
[private bootstrap](goal-private-bootstrap.md) for the current contract.

## Single canonical facade

CompanyService constructs exactly one GoalLifecycle with `goalAuthentication`.
WebServer uses its actual OwnerAuthService and exact CompanyStore filename, and
production registers `registerGoalServiceRoutes(app, companyService.goals)`.
The older store/auth route helper is retained for isolated core tests. Canonical
binding and actions come from actual services, not configurable allow-all callbacks.

`reverie web --goal-private-config /absolute/private/goals.json` now supplies
reviewed private configuration to that assembly. Omission, or an unprovisioned
low-level constructor, leaves Goals unavailable even with a real owner cookie.
An explicit invalid configuration refuses startup. This is an implemented optional
launcher, not automatic trust provisioning or an environment/HTTP callback loader.
Mixed low-level and provisioning inputs refuse.

## Authentication and commit boundaries

In supported owner-only mode the separate owner adapter accepts only genuine
current unrestricted primary-owner cookies, with same-origin mutation protection.
Any present invalid/mixed/proof/agent/service credentials refuse rather than fall
back. The employee adapter's authenticate and assertCurrent always deny, without
issuer/key-content/nonce calls. Complete private namespace/key metadata and fresh
custody are still mandatory. The restricted broker supports only owner-only G;
OfficeAPI installs no Goal signer and refuses reserved Goal paths before upstream
or credential access. Employee original-program observation/signing is separate
unimplemented source work, not a configuration-only step.

For trusted component/embedding configurations, `GoalServerPorts.employee` and its
matching raw-body/provenance boundary retain the accepted HMAC/nonce/current-proof
contract. Tests explicitly supplying synthetic proof-component trust do not prove
normal Office employee transport. Missing ports remain default-denied.

The outer owner-policy hook defers only exact registered Goal method/route tuples
to the mandatory preHandler gate, allowing raw-body verification to run first.
No broad Goal prefix, generic service grant or parent/Basic/body/title authority
is added. The gate applies in off/log/enforce modes. Limited owner cookies are
refused before any special Goal handling.

Current authentication, custody and explicit synchronous action/revocation checks
repeat in the canonical core before atomic commit. Generation, session binding,
CAS/idempotency, migration fences, expiry, replay, exact owner-issued grants and
scoped privacy remain independent checks. Adoption and grant/proof authority remain
owner-only; no Goal action authorizes execution, delegation, wake, model or recovery.
No second Goal store is created. The accepted health reader uses the same canonical
store and registry but remains purpose-scoped, separate from active authorization.

## Acceptance boundaries

Actual route tests use app.inject and owned synthetic private fixtures. Owner
launcher controls cross the real restricted broker boundary with fixture cookies;
employee-positive component controls select explicit synthetic key/binding/clock
proof mode. Real-Office/default-unavailable403 negatives remain required. Neither
kind attests actual engine inventory, installed helper ownership or host custody.

Exact-source independent review, native/image/mounted-root checks, real private
provisioning/continuity and authorized installed owner canaries remain required.
Interrupted migration is never automatically reconciled or cleared; no recovery
or existing-session adoption is inferred. Preserve later website source changes.

Schema-capable adapters-OFF source must preserve every populated Goal/generation
and nonce record through ordinary authenticated canonical writes. The logical
same-source OFF witness is not production/image rollback approval. Old0b3 and
whole-state backup restoration cannot safely follow new Goal writes. No metadata
drop, ledger reset, host/image activation or employee signing is authorized here.
