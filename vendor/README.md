# Pinned regex dependencies

`rustpython-sre-engine` and `rustpython-wtf8` come from
[RustPython d02d81e740e67496a70579282c848358e461d0d0](https://github.com/RustPython/RustPython/tree/d02d81e740e67496a70579282c848358e461d0d0/crates).
This pin supports the workspace's Rust 1.95 toolchain. The standalone matcher
and WTF8 utility have no Python VM/parser/compiler/runtime dependency. Their
original MIT license is retained in each directory. WTF8 documents its Rust
1.85 standard-library ancestry; those MIT/Apache licenses are retained as well.

These directories are third-party source dependencies, explicitly excluded
from workspace membership. Their inherited unsafe implementations remain
third-party review scope, not a blanket exemption for Reverie's compiler,
Core facts or Host consumer; all first-party crates inherit workspace lints.
The first-party compiler exposes only opaque checked compiled patterns.

The matcher fork makes three purpose corrections:

* Unicode classes/simple lower/upper call the one frozen Core owner, replacing
  newer upstream Unicode facts without copying tables into the matcher.
* Empty-string non-boundary matches Python 3.13 rather than Python 3.14.
* Five return paths discard their own saved capture frame: failed negative
  assertions and successful branches/greedy-one/lazy-one/generic-lazy repeats.
  Actual CPython cases demonstrate both false positives and false negatives
  before these changes; frame restoration on failure remains unchanged.

WTF8 encoding and iteration source is unchanged. Only its three unused Unicode
trim APIs have an explicit `unicode-trim` feature gate. That feature is off in
the matcher graph, so bstr's current-Unicode regex tables are not dependencies
of runtime matching. There is no surrogate-pair normalization. Manifests bind
the standalone dependencies and omit upstream VM/bench/dev machinery.

The first-party grammar/compiler is derived from CPython 3.13.15 `re/_parser.py`,
`re/_compiler.py`, `re/_constants.py` and `re/_casefix.py`, reimplemented in safe
Rust with iterative ownership. Its CPython license and original notices remain
in `crates/reverie-python-regex/CPYTHON-LICENSE`. Frozen Unicode facts retain
their existing Core provenance/license owner. Qualification artifacts bind the
exact upstream and modified source hashes; updating this fork requires reviewing
that delta and the actual runtime dependency tree again.
