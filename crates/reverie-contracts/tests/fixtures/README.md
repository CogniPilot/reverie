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

`worker-config-python-interop.json` was generated in one disposable Python oracle
invocation from synthetic data using the frozen worker hash expressions:
`json.dumps(value, sort_keys=True).encode()` and the same expression after
excluding exactly three top-level policy keys. No generator or Python program is
added to the source tree. Each case records input JSON, independent expected
config/policy bytes and SHA-256 hashes. Cases include the existing 500 CPU float
witnesses, finite IEEE-bit probes, exponent boundaries, arbitrary-precision
integers, Unicode/supplementary/lone-surrogate strings, escaping, nested excluded
names and omitted/null/empty options. Partial objects exercise codec semantics;
they do not claim to pass full worker validation or host readiness.

Additional nonfinite/overflow/underflow cases use the actual legacy
`worker.validate_config` with owned synthetic mount directories and disabled
rootless-Docker configuration. Their recorded validation outcome demonstrates
why this named hash-data codec must retain Python's default `allow_nan=True`
spellings. The real `worker_resources.policy_digest` is also compared to the
recorded policy hash. Fixtures contain no live host paths or company data.

`lease-policy-python-interop.json` records actual frozen `peer_port.validate_option`
and `worker_config` data behavior: 53 option and 22 projection cases. The
projection oracle reads only owned temporary synthetic company files and stubs
artifact observation explicitly; it proves projection bytes, not immutable
artifact custody or native/mounted execution. `peer-elf-python-interop.json`
records 14 actual `peer_artifact.static_elf` outcomes with declared architecture
patched for synthetic header-policy cases. It does not qualify a machine or
execute any helper. No Python generator is added to the source tree.
# Resource composition

`resource-config-python-interop.json` contains actual existing Python
`worker_resources.resource_config` results for synthetic configurations. Employee
fallback identity is explicitly stubbed in those pure cases. The `staged` rows
bind the six existing `broker-resource-staging.json` cases by index to actual
`effective_config` bytes and both legacy hashes. These are format/behavior
oracles, not evidence of live data migration or host permission.
`posix-path-python-interop.json` records 106 actual pathlib.PurePosixPath
normalizations/parents and 1,300 seeded join/descendant/overlap pairs. Codepoint
arrays preserve lone surrogates and NUL without a JSON string decoder deciding
their meaning. The fixtures qualify lexical data only, never native path
existence, canonical control domains or mount permission.
