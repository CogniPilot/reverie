# Named compatibility codecs

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
duplicate keys and retains opaque unrelated identities. UUID validation applies
when selecting a storage identity. Owners retain Python's 200-codepoint bound;
current GPU generations are positive Python integers without a JS-safe ceiling.
Numeric duplicate-session comparison preserves Python bool/int/float equality
without casting arbitrary integers to floats. Desired-running/vacation checks
retain the existing exact-false and truthiness semantics.

These are data readers. The owning native store checks file custody and read
stability; the application still owns authorization, leases, outer admission and
operation completion. No reader grants storage publication or execution rights.

# Subscription profiles v1 JS codec

`subscription_profiles_v1` is the forwarded request and the exact response bytes of the TS route
`GET /api/subscription-profiles`. It is a separate codec from `profiles_v1`: the file grammar is
ECMAScript `JSON.parse` (last duplicate key wins, lone surrogates kept, any nesting depth), the schema is
zod 4.4.3 `subscriptionProfileSchema` (strict except `__proto__`, JS `trim`, UTF-16 lengths, Node
`path.isAbsolute`), and the body is `JSON.stringify` output. Strings stay UTF-16 code units throughout.

The request carries what only TS owns: `os.homedir()`, `process.cwd()`, `process.platform`, `getDataDir()`
and the three environment values the route reads. The memoized CLI-registry modes are not in it: TS reads
them after the profile file and only when it found profiles, so the handler asks for them then, and
`decode_modes` accepts exactly the providers it asked for. Bounds TS lacks
(request, file and response size) are typed refusals that the forwarder answers with its curated 503.
`reverie-routes` holds the read-only handler; its byte goldens are recorded from the TS route.

# Route frames v1

`route_frames_v1` is the private channel between the TS front and a Rust route handler child on its
stdin and stdout. A frame is a big-endian `u32 length`, an 18-byte header (`u8 version`, `u8 kind`,
`u64 generation`, `u64 id`, no padding) and the kind's payload. Requests, cancels and observation
answers go to the handler; responses, refusals and observation requests come back. Each kind has an
exact length range, and a reader checks `length` against its direction after 4 bytes and against the
kind after 6, before it allocates a payload. End of input between frames is clean; inside one it is
`FRAME_TRUNCATED`. Every refused frame ends the generation; the codes are shared with TS.

A response carries only a status and body: the route table fixes each route's content type and
allowed statuses, so the handler sets no headers. An observation request names a TS-owned value the
handler needs after its own read, such as the CLI-registry modes, so TS keeps its original read order.
Both readers decode the shared cases in `tests/fixtures/route-frames-v1/cases.json`, which were
written independently of either encoder.

