These public synthetic fixtures were produced from the existing frozen
`0cc46ab8de6d0ae981c618e40fb00ed03b897b02` Python implementations during independent
adversarial review. They contain generated identifiers and numerical probes, no
instance records or credentials. The original corpus has subsequently grown from
69 to 82 cases; its provenance and individual outcomes remain in the JSON.
The opaque legacy `force-*` identifier example uses a synthetic replacement in
this public copy; its validation outcomes and all byte/hash vectors are unchanged.

Tests consume the profile-validator/byte/hash vectors, UUID distinctions and 500
valid CPU float witnesses. The broader generic JSON/Unicode/operation-ledger cases
are retained as migration evidence; this closed ASCII profile codec does not claim
to implement those other schemas. Byte-encoding, duplicate-key, bound and CAS
refusal cases are also tested directly through the real profile codec/domain.
