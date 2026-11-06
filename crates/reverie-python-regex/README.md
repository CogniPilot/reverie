# Native memory output-policy regex

This library compiles the existing `re.I` Python 3.13 **str** grammar into a
private program for the pinned standalone SRE matcher. It ships no Python
interpreter, VM, Python parser/compiler, subprocess fallback, or new pattern
subset. `CompiledPattern` accepts checked lossless `PythonTextRef` input;
adjacent surrogate codepoints remain distinct. There is no public bytecode
constructor. `CompiledOutputPolicy` compiles every rule before searching any
rule. The actual Host `MemoryScreen` uses this API before reading protected names.

The parser uses a flat arena and explicit group/work stacks. Compiler widths,
groups, escapes, scoped flags, assertion/backreference checks and diagnostic
order follow CPython 3.13.15. This includes observable outer-flag charset prefix
filtering, even for scoped ASCII categories. Warning-only grammar is accepted;
the supported screening result does not expose Python's warning stream.

One intentional robustness correction is explicit: syntactically valid deep
patterns can compile beyond CPython's context-dependent interpreter recursion
limit. The fixture retains the original `RecursionError` witnesses; native
acceptance does not claim interpreter stack-exhaustion parity. Invalid grammar
still refuses before search. Matching retains the existing backtracking algorithm;
this change adds no new timeout or restricted syntax policy.

Core owns all frozen Python 3.13 / Unicode 15.1 character classes, simple case
maps, identifiers, regex case additions and name lookup. `unicode_names2` is
pinned to 1.2.2 (its packaged Unicode 15.1 data), with the exact CPython CJK name
lexical check. Its code generator is a build dependency, not an interpreter.
See [third-party fork provenance](../../vendor/README.md).

Tests retain actual CPython source oracles for 425 original matcher cases,
8,130 composed matcher cases, 1,800 capture savepoints, 9,900 scoped prefix
combinations, 629 grammar cases, 55 diagnostics, seven compile-before-search
cases and 18 deep-pattern witnesses. Core checks every codepoint against the
frozen word/space/decimal/simple-case oracles. The broader qualification also
compared 288,299 canonical/alias/case/name inputs against actual Python lookup
and compilation; no live instance patterns or private data were inventoried.

This source library does not publish a memory context, authenticate a caller,
select a runtime, migrate data or qualify the actual guest installation closure.
