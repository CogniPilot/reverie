# Profile v1 compatibility codec

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

# Subscription profiles v1 JS codec

`subscription_profiles_v1` is the forwarded request and the exact response bytes of the TS route
`GET /api/subscription-profiles`. It is a separate codec from `profiles_v1`: the file grammar is
ECMAScript `JSON.parse` (last duplicate key wins, lone surrogates kept, any nesting depth), the schema is
zod 4.4.3 `subscriptionProfileSchema` (strict except `__proto__`, JS `trim`, UTF-16 lengths, Node
`path.isAbsolute`), and the body is `JSON.stringify` output. Strings stay UTF-16 code units throughout.

The request carries what only TS owns: its memoized CLI-registry modes, `os.homedir()`, `process.cwd()`,
`process.platform`, `getDataDir()` and the three environment values the route reads. Bounds TS lacks
(request, file and response size) are typed refusals that the forwarder answers with its curated 503.
`reverie-routes` holds the read-only handler; its byte goldens are recorded from the TS route.
