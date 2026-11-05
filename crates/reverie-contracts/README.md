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
