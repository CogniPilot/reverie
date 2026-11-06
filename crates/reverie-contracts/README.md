# Named compatibility codecs

`worker_launch` decodes default bounded broker request bytes and prepares
lossless create/tmux/account argv data from checked upstream configuration.
Environment insertion order and raw path spelling survive; no plan is an
admission, mount, owner or execution grant.

`memory` preserves the existing SQLite memory metadata/source fields and the
embedding request/response data contract. The one shared private JSON parser can
retain a flat insertion-order companion graph: last-value duplicate replacement
keeps the first key position, including nested replaced objects and lone-surrogate
keys. Named memory fields use Python `str` JSON; HTTP response bytes retain the
separate BOM/UTF16/32 detector. Both preserve the existing default Python constants
and 4300-digit integer behavior. Other named parse policies remain unchanged.

The graph, traversal and builder stay private. Public memory data exposes whole
named fields and the specific dream-release change, with the original default
spacing, truthiness, recall coercion and `as_dict` behavior. The latter omits the
embedding. HTTP response dimensions are available before numerical coercion;
response vectors retain the source's sequence and float conversion rules.

This checkpoint contains no HTTP transport, provider probing, SQLite connection
or selected service consumer. Runtime proxy/redirect/fallback behavior and complete
database interoperability require their own composed service qualification.

`operations_v1` preserves the closed resource-operation journal, compact sorted
ASCII bytes and named request/observation/operation/scope fingerprints. It uses
the existing private JSON/encoding owners, rejects duplicate fields, JSON floats,
nonfinite constants, signed integer tokens (including `-0`), unsafe counters and
noncanonical decimal-string uint64 values. Python byte encoding detection is
retained. Ninety-one actual reference cases cover successful states, bounds,
capacity arithmetic, exact bytes/hashes and refusal codes. These data and hashes
confer neither owner approval nor native effect or settlement authority.

`profiles_v1` implements the closed
`reverie-employee-resource-profiles-v1` document and single-profile encoding used
by `python/reverie/employee_resource_profiles.py` at the frozen migration base.

Decode checks size, schema, duplicate keys, field types and domain invariants.
Legacy UTF-8/BOM, UTF-16 and UTF-32 input encodings are accepted for valid profile
documents. Successful encoding always produces compact sorted-key ASCII JSON.
Every string admitted by this schema is a fixed literal or a checked ASCII UUID.
Free-form JSON and other stores require their own named compatibility codecs.

CPU lexical integer/float identity, signed float zero and exact finite values
survive decoding. Workspace `serde_json/float_roundtrip` is enabled; CPU values
also use RawValue with Rust's correctly rounded numeric parser. Duplicate keys
are rejected before map insertion can hide them.

`ProfileDigest` hashes one resource profile; `ProfileDocumentDigest` hashes the
whole document. Their Rust types are distinct. Hashes and decoded values grant
no owner permission, store custody or native completion authority.

Interop tests use independently produced synthetic Python byte/hash fixtures,
500 valid CPU float witnesses, malformed schemas and legacy encoding cases.
The [fixture notes](tests/fixtures/README.md) describe the scope and provenance.

`worker_config` owns the separate legacy effective-worker hash input used by
`worker.py::create_args` and `worker_resources.py::policy_digest`. It emits sorted
ASCII JSON with Python's default `, ` and `: ` separators. `WorkerConfigDigest`
includes the entire effective object; `WorkerPolicyDigest` excludes only its
top-level `image`, `maintenanceSessions` and `opsConfig` keys. Nested keys with
those names remain included. Missing, null and empty values remain distinct.

The decoder accepts a duplicate-free Python JSON object as already projected
configuration **data**. It does not validate the worker schema, read host facts,
run effective-config projections or approve any effect. It preserves arbitrary
decimal integer precision, integer/float identity, signed float zero, Unicode
codepoint key ordering and escaped lone surrogates. Those distinctions matter:
accepted disabled-rootless configuration slots can contain unconstrained JSON,
and some accepted legacy path strings need not be Unicode scalar strings.
Python's legacy `NaN`, `Infinity` and `-Infinity` spellings (including exponent
overflow to infinity) remain hashable data here because disabled-rootless slots
accept them. Strict profile/resource and wire validators remain unchanged.
Parsing, writing and cleanup use iterative traversal instead of imposing a new
shallow nesting bound. Duplicate keys are explicitly refused; the existing
legacy reader may accept them, so this codec is not its replacement without the
owning migration's validation. Input text is UTF-8, matching the
worker config's `Path.read_text()` followed by `json.loads`; it does not use the
separate metadata byte-encoding detector.

`storage_identity` provides named read-side views for company current/retired
records, `storage-owner.json`, historical plan-move edges and current employee
selection. It uses shared private lossless JSON primitives, not the effective
worker hash wrapper or a generic JSON editing API. The metadata reader preserves
Python `json.loads(bytes)` UTF-8/BOM, UTF-16/32 and surrogatepass behavior, rejects
duplicate keys when each object closes and retains opaque unrelated identities.
Its named parser enforces Python's default 4300-digit signed integer-token bound;
literal nonfinite values and exponent overflow remain accepted metadata data.
Existing effective-worker hash parsing keeps its separate default behavior.
UUID validation applies
when selecting a storage identity. Owners retain Python's 200-codepoint bound;
current GPU generations are positive Python integers without a JS-safe ceiling.
Numeric duplicate-session comparison preserves Python bool/int/float equality
without casting arbitrary integers to floats. Desired-running/vacation checks
retain the existing exact-false and truthiness semantics.

These are data readers. The owning native store checks file custody and read
stability; the application still owns authorization, leases, outer admission and
operation completion. No reader grants storage publication or execution rights.

`broker_resources` bridges captured broker configuration data to the checked
core resource-map projection. It preserves every unrelated value, including
numeric kind, lone surrogates and unrelated resource-entry bytes after canonical
encoding. Only the selected employee/target-session entries change. The source
clone retains the legacy compact-ASCII 128-KiB input bound and finite-value
requirement; this differs intentionally from general worker hash data. Staged
output may grow beyond that clone bound, as in the existing implementation.

This is neither a full worker schema validator nor a completed `stage_config`
workflow. The application must retain checked profile-store custody and resolve
current storage/GPU/perf/memory/lease facts before deriving an effective policy
digest or publishing any configuration. Candidate bytes are protected application
data, not a browser response, owner grant or native effect receipt. Six existing
Python staging vectors cover exact configuration bytes and unchanged original
profile digests, without using live company data.

`task_perf_v1` owns the closed fixed manifest and whole-base task-v1 seccomp
derivative. It verifies exact raw profile hashes and compares the entire decoded
profile with Python's numeric/container equality, including bool/int/float,
large integers and nested parsed NaN. It preserves all other rules and fields;
applying the rule twice refuses. A named perf configuration view checks the
bounded employee policy map and literal rootless enabled flag, then replaces
only the selected fixed profile/hash and adds the task-v1 marker. Unknown worker
configuration fields remain lossless. These are data transforms, not native
artifact custody, owner permission, full Docker validation or a kernel grant.
The separate Linux host adapter supplies fixed package observation and current
employee bracketing; current production Python consumers remain selected.

## GPU and soft-memory projections

`device_policy::{gpu,memory}` exposes named feature validation/projection over
the existing lossless `EffectiveWorkerConfig` data. Only projected `gpuGrants`
or `laptopMemoryPolicy` entries change. Other strings, numeric kinds and opaque
configuration remain in their existing data nodes; projections never clone JSON
through serialization or impose the stage-only finite/128-KiB clone guard.

Direct GPU validation checks both explicit maps and the combined bound. The
`resource_config` callsite separately requires the employee GPU map to be an
object, then skips GPU projection when it is empty; inactive malformed legacy
GPU data is retained as before. Direct memory validation checks the map and pool
even when empty, while its `resource_config` callsite uses existing Python
truthiness before invoking that feature. The shared private JSON truthiness
helper also remains the owner of storage-identity truthiness behavior.

GPU projection accepts current employee observation data, checks its SID when
needed, and retains legacy SID priority and absent-versus-empty map shape.
Native composition must obtain that data freshly; historical storage alone
cannot select an employee GPU grant. Memory selection instead uses the trusted
storage identity, including historical employee storage.

Selected memory-high projection accepts the actual checked effective
`ResourcePolicy` and binds its integer RAM ceiling to resource data. It does not
claim compatibility with malformed arbitrary Python private-helper arguments
such as floating or infinite RAM values. Unselected and swap-only paths leave
RAM data untouched. `swap_bytes` operates on checked projected policy data, with
the existing zero default for no selected policy; it is not an admission check.

Nineteen synthetic old-Python `resource_config` and `policy_digest` cases qualify
exact bytes and hashes. Only current/storage identity observations are stubbed
in these pure oracles; native read custody and drift tests are separate. These
projections expose no owner authority, host fact receipt, endpoint or writer.

`lease_policy` captures the existing `leaseAcceptance` option from already
projected worker data. Absent/null options retain the original configuration;
an enabled option is removed for both selected and unselected SIDs. Only its
exact current selected SID receives the one readonly peer mount. Current lease
selection intentionally adds no owner, generation, retirement, running-intent
or unrelated-ID uniqueness gates from the separate GPU/storage readers.
The company reader preserves `I.decoded`'s rejection of literal nonfinite
constants while retaining Python exponent-overflow behavior.

Pure lease projections are candidates with an explicit required-artifact path.
Native observation must validate the owner-selected immutable peer binary before
acknowledging a selected projection. These values confer no peer invocation,
socket service, lease, start authority or mounted/kernel proof. The artifact
path remains the existing immutable owner configuration setting, not a new
public administration path parameter.

`resource_config` composes the existing resource selection and ten control-key
omissions without JSON round trips. SID projections retain priority over trusted
storage-EID fallback; selected resource values use the same checked parser and
encoder as profile staging. The perf input seam restores only the original
employee policy map onto already projected resource data. Native identity paths
come from that same captured source, preserving Python codepoints for the native
filesystem adapter. Twenty-three actual Python cases cover bytes, policy hashes
and refusals; six original staging cases also retain final effective hashes.
This feature view assumes the caller's validated worker domain; it is not the
full worker schema validator or an authorization interface.

`worker_schema::WorkerEnvelope` now checks the complete pure envelope/base and
mount declaration unit while retaining the captured data exactly. Its separate
feature method reuses existing map/lease policy owners. Native source custody
and full ordered validation remain outside that envelope. The complete ordered
application service now composes those purpose owners; see the
[source-backed ownership audit](src/worker_schema/README.md).

`rootless` ports the rootless option/profile/syscall, image-label and subordinate
grant data rules, sharing mount and fixed perf owners. Its [compatibility audit](src/rootless/README.md)
records parsing quirks, native observations and the remaining engine boundary.
