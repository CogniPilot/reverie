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
- `TaskPerfPolicies` validates the bounded employee task-v1 map and its rootless
  Docker prerequisite. Its fixed rule matches only the low signed32-bit CPU=-1
  argument; selection and rule data never grant a capability or start permission.
- `ResourceTemplate` validates six-field configuration before a reservation-pool
  override. `PoolLimits` owns pool bounds; resolving a template enforces the
  effective memory/pool relationship and yields a strict `ResourcePolicy`.
- `ResourceProjection` validates bounded session/employee maps and stages only
  the selected employee and target session from a canonical profile. It checks
  revision, version, binding and both observed session owners, while retaining
  unrelated entries and the original profile exactly. A present reservation
  option uses the global pool regardless of that option's truthiness.
- `ProfileDocument::apply` checks revision, prior profile version and binding,
  producing a new immutable document. The owning store performs the locked
  filesystem transaction and handles uncertain commits.

These values are data. Owner authorization, current binding provenance and native
effect authority remain responsibilities of their application/runtime owners.
See the [specification index](../../spec/README.md).

Resource staging here is only the pure resource-map portion of Python
`ProfileStore.stage_config`. Its input binding and owner map are data, not grants.
The application must obtain them from current trusted sources and retain store
custody through full staging. Host-backed GPU, perf, memory, storage and lease facts,
the legacy effective-config digest, admission and compatibility checks remain
with the owning application/host components. This crate neither constructs that
digest nor persists/reloads config, creates an endpoint or cuts over a consumer.

## GPU and soft-memory policy data

`device_policy` owns bounded GPU maps, physical NVIDIA CDI token syntax and
soft-memory/swap policy rules. Device token hex case and absent-versus-empty
legacy GPU maps survive projection. Legacy SID grants take priority over an
employee-derived grant, and the two explicit maps share the 32-entry bound.

Soft-memory policies require swap and optionally a high threshold, with bounded
pool commitments. A selected high threshold requires the actual checked
effective `ResourcePolicy` RAM ceiling and must be strictly smaller. Unselected
and swap-only projections do not inspect a RAM ceiling. Checked swap byte counts
are commitment data; they provide no disk reservation, swap admission, cgroup
write or start permission. These types do not resolve employee identity.
