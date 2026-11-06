These closed data contracts implement the existing GPU owner command, request
store, current binding hash, selected native-row projection, proposed GPU-only
config patch, transition intent, and default-spaced C reply bytes. They reuse the
single Python JSON/text/UUID/resource owners. Profile session nil-UUID behavior
remains separate from nonnil journal request identities. Expected client
generation is unbounded positive integer data; queued/current generations retain
the original safe-integer bound. No schema/hash is a native permission.

CDI parsing preserves the entire original safe-document validation, including
ignored tagged data, duplicate and non-string map keys, aliases, typed ignored
values, scalar codepoints and selected-edit iterable behavior. It does not coerce
YAML into JSON. libyaml-safer supplies the safe Rust grammar scanner/parser;
Python's YAML 1.1 constructors and purpose rules are applied separately. Actual
scanner tokens/error marks identify directive compatibility adjustments, leaving
comments and scalar lookalikes intact. Fresh unused TAG handles represent ignored
unknown directives without losing the parser's explicit-document-start rule;
ASCII handles absent from the source cannot affect its node tag resolution.

The shared JSON diagnostic seam records only recognized NaN/Infinity literal
refusal at the existing parser decision. Malformed tokens and exponent overflow
remain distinct. No acceptance mode or second JSON tokenizer is added. Grammar,
number/text/schema and side-effect compatibility do not promise dynamic CPython
or PyYAML interpreter recursion/stack exhaustion. Captured graphs use flat nodes
and iterative destruction rather than adding a hidden depth cap.
