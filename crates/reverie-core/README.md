# Reverie core data and algorithms

`posix_text` is the shared portable UTF-8/surrogateescape byte/codepoint owner.
It performs no path normalization or filesystem lookup; native host/store
adapters decide when to encode captured text and independently check custody.
CPU nano-ceiling arithmetic and observation numeric validation stay in their
existing checked resource/journal owners, separate from ID or effect authority.

`memory` owns the existing `hashed-v1-N` lexical embedding algorithm, signed
eight-byte BLAKE2b buckets, first-feature accumulation order, Python 3.13
compensated summation, native float32 vector packing and retrieval scoring.
The hashed backend remains the existing lexical fallback; it makes no claim of
model inference or semantic retrieval quality. An explicit backend identity
continues to distinguish stored vectors.

Unicode 15.1 lowercase, final-sigma context, alphanumeric, decimal, printable and
whitespace facts are frozen to the accepted Python runtime rather than Rust's
changing Unicode tables. They preserve voice claims and numerical/text coercion.
The Unicode data license is retained beside the tables. The port has no Python
build or runtime dependency. Fixtures cover actual Python tokens, f64 values,
stored f32 bytes, scores, HTTP float coercion and metadata string representation.

`python_regex` exposes purpose-specific frozen facts to the native compiler and
standalone matcher: Python 3.13 simple lower/upper, word/decimal/space classes,
identifier/alphabetic predicates, regex case additions and Unicode 15.1 named
characters. Existing lowercase/character tables remain the single owner.
Additional uppercase and identifier facts were exhaustively qualified against
the accepted Python runtime, including lone surrogates. The named-character
dependency is pinned to Unicode 15.1 and its CJK lexical check follows CPython.
Core depends on no matcher or regex compiler, so this seam introduces no cycle.

The private `python_text` owner shares those unchanged frozen tables across
scalar memory operations and lossless codepoint consumers such as hostnames and
nonpersisted model/query text. Lone surrogates retain Python's lower-case
context behavior; the existing public memory helpers remain available.

Scores use the existing real-valued f64/JSON contract. Negative decay and unusual
weights remain accepted when their powers produce real results, including IEEE
infinite/NaN cases. A power for which Python returns a complex value produces an
explicit `Domain` refusal here; this is not a general Python complex arithmetic
port. No positive-only decay or finite-only weight restriction is introduced.

This component performs no SQLite, HTTP, provider selection, re-embedding or
deployment. Persistence and service workflows remain separate owners.

`memory_configuration` captures the existing named integer, float and text
settings without clamping accepted Python integers to i64. It shares the frozen
Unicode numeric facts and float parser. Configured negative hashed dimensions
retain their original model name and empty-feature behavior; out-of-Py_ssize_t
counts fail at embedding allocation instead of changing configuration identity.
`memory_instance` owns identifier/kind/tone data only. `memory_documents` owns
document revisions, developer names, ballot categories and runtime week math.
`persona` renders the existing deterministic reflection profile, sharing the
pinned ranking and Unicode owners. None of these labels supplies a permission.

Retrieval ordering pins CPython3.13.15's powersort/count-run/gallop policy in
safe Rust. NaN keys make the exact run schedule observable, so a different
stable sorter changes retained results. Eighty actual Python rank vectors span
minrun boundaries and unordered/finite run shapes; SQLite retrieval adds120
end-to-end vectors. The original PSF license and source provenance are retained
beside the narrowly scoped implementation. It grants no persistence authority.

`operations` owns the existing resource journal's checked nonnil identifiers,
unsigned memory references, phase/receipt rules, conservative positive deltas,
idempotency uniqueness and shared pool accounting. Core completion candidates
are data only; they cannot publish a journal or mint native settlement proof.
The named contracts codec separately owns canonical fingerprints. Operation
records expose immutable checked observations rather than mutable file state.

This crate provides the checked identities, counters, resource policies and pure
profile CAS projection used by the Rust profile-store migration. Fields carrying
invariants are private; public constructors return checked values.

`worker_schema` owns checked worker base identity/count/UID data and pure POSIX
mount target, immutable-rootless and account-target rules. It reuses resource
bounds and retains codepoints, without filesystem/seccomp/start qualification.
See the contracts [validation audit](../reverie-contracts/src/worker_schema/README.md).

`rootless` owns arbitrary-precision subordinate-ID containment. Checked decimal
data and containment results are neither host observations nor access grants.

`decimal` supplies shared exact unsigned arithmetic without schema bounds;
`capacity` applies the existing signed63-bit explicit policy bounds, exact host/
pool sums and the separate legacy floating90%+8GiB rule. Rootless and journal
domains retain their own bounds. Arithmetic data never qualifies a native fact.

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

`lease_policy` owns the legacy lease grant's pure POSIX lexical path rules,
control-directory and mount namespace/alias checks, and native ELF64 static
header policy. Codepoint path data retain lone surrogates; the lease socket's
UTF-8 byte bound is checked separately. A canonical nil employee/session UUID
remains accepted. ELF header acceptance neither executes the binary nor proves
its immutable host custody, mounted identity or kernel behavior.

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
## POSIX lexical data

`posix_path::PosixPath` owns Python-compatible lexical path normalization,
parent/join and descendant/overlap comparisons independently of the build OS.
It preserves the double-slash anchor, '..' and Python codepoints. These values
establish no filesystem resolution, custody or mount authority. The existing
lease broker-parent comparison reuses this owner; source/control path policies
remain the responsibility of their respective consumers.

`worker_launch` owns the worker environment-key vocabulary, checked request text,
cwd/terminal/account-namespace rules, derived worker/container references and
ASCII employee hostname labels. The native client reuses the key owner without
inheriting broker value/frame bounds. These values are data, never peer grants.

`PythonText` and `PythonTextRef` share one checked Python-codepoint invariant
for owned and borrowed data, including NUL and lone surrogates. Trimming uses
the existing frozen Python whitespace facts; slicing counts codepoints. No OS
encoding, replacement, normalization, serde or authority is implied. Existing
metadata text wraps the owned value; named memory inputs may delegate to the
borrowed view without duplicating text rules.
