# Checked profile domain

This crate provides the checked identities, counters, resource policies and pure
profile CAS projection used by the Rust profile-store migration. Fields carrying
invariants are private; public constructors return checked values.

- `ProfileEmployeeId` and `ProfileSessionId` preserve lexical UUID compatibility,
  including nil. `NativeOperationId` rejects nil. These purpose-specific values
  do not redefine general legacy company/session identifiers.
- Counters distinguish zero-based store/observed versions from positive profile
  versions and generations, retaining JavaScript-safe bounds.
- Resource policies preserve admission/pool differences and finite CPU limits.
  CPU values retain integer versus float encoding identity and signed float zero.
- `ProfileDocument::apply` checks revision, prior profile version and binding,
  producing a new immutable document. The owning store performs the locked
  filesystem transaction and handles uncertain commits.

These values are data. Owner authorization, current binding provenance and native
effect authority remain responsibilities of their application/runtime owners.
See the [specification index](../../spec/README.md).
