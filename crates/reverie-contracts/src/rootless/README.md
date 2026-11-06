# Rootless worker service compatibility

Source: `worker_docker.py` at the frozen `f4049535` base. Core owns arbitrary
decimal subordinate-ID containment; contracts own captured configuration,
profile/syscall and image label rules, grant text parsing and argument data;
host owns Nix profile, fixed perf and fixed system grant observations. Existing
worker-schema rules supply immutable/account mounts and strict UID/GID bounds.

`RootlessConfig::capture` validates the pure option, identities and immutable
mounts. Its `enabled()` means a checked enabled request, not native qualification.
Missing/null is inactive. Disabled requires exactly three keys and literal-bool
enabled, while leaving profile/digest and unrelated data arbitrary, including
nonfinite/deeply nested values. Captured configuration and raw profile arguments
remain unchanged; no defaults are inserted.

`reverie_host::rootless::observe_rootless` completes the original enabled unit:
it observes the selected immutable Nix profile, validates raw SHA256, decodes
profile data, checks default denial and capability-applicable syscalls, and
obtains the actual installed fixed perf artifact when a marker is present.
Only CAP_SETUID/SETGID applicability is considered, as before. Native metadata
accepts UID0/current UID, no group/other writes and at most 65,536 bytes; FD/named
stamps and checked close handling fence drift. Hard links/owner writes remain
accepted. Actual filesystem custody is independent of captured option data.

Normal profiles use Python `json.loads(bytes)`: BOM/UTF16/32 detection, last key
wins, integer/float provenance, lone surrogates and nonfinite extras survive.
The private parser mode preserves the frozen 4300-digit raw JSON integer token
limit even in ignored/overwritten data, without limiting float tokens. It is
selected only by named rootless readers. Fixed perf
artifacts, profiles and registries retain strict duplicate rules. Already decoded
normal profile DATA is compared during fixed perf recognition without validating
unrelated employee maps. Exact permitted perf rule/equality uses the existing
task-v1 owner, including Python numeric bool/int/float comparisons.

Rule iteration preserves Python's accepted iterable/set behavior: empty
object/string syscall containers iterate zero times; string name/capability sets
contain characters; dictionaries contribute keys. Nested array/object set
members refuse as unhashable. Missing action/names are checked only on the
original applicable/allow path. This does not assert Docker accepts every
profile admitted by the legacy policy checker.

`require_rootless_accounts` freshly qualifies the profile and applies shared
account/disjoint rules to final destination data. Inactive mode does not inspect
even invalid destinations. It neither mounts accounts nor resolves image links.

`require_rootless_image` freshly qualifies the profile, checks user and
capability/layout labels, compares the real broker UID, parses subordinate
metadata and reads only `/etc/subuid` and `/etc/subgid` with real `getpwuid_r`.
The fixed paths may resolve symlinks. Resolved regular files require UID0,
no group/other writes and at most 1 MiB; FD/named stamps and checked closes fence
drift. UID containment failure skips GID read, as before. There is no production
source/path override or generated-grant fallback.

Image inspection remains caller-captured data, not proof of selected engine or
image identity. Python `int` conversions retain bool, finite float truncation,
signs, underscores, Unicode decimals, surrounding accepted whitespace and
arbitrary signed magnitude. Signed intermediate values retain negative UID/GID
starts until the original host read/containment step; negative counts stop
before host reads. Core nonnegative arithmetic has no machine-integer overflow.
The measured Python 3.13 Unicode 15.1 decimal/digit table has one owner in
`integers.rs`; the frozen 4300-digit string conversion limit is kept. Host text
uses strict UTF-8, Python splitlines, name-or-decimal-UID matching and `isdigit`
before `int`: superscript digits can pass the former and still fail conversion.

Arguments are codepoint data in the original order. They invoke no engine,
grant no capability and retain no native custody lease. A create/run consumer
must requalify immediately before use, bind real engine image inspection and
final account/mount data, and enforce image/kernel/device/sub-ID/cgroup checks
at its effect boundary. No endpoint, selector, mutation or deployment is added.
Whole-worker validation and engine invocation remain separate work.

The synthetic corpus contains 56 profile/toggle/argument cases, 524 image cases
(including 500 seeded float-to-int witnesses) and 817 grant-text cases (every
frozen Unicode `isdigit` character). Profile oracles map only Nix location to
an owned actual readonly file. Image oracles explicitly stub enabled and grant
ranges; grant text oracles synthesize root metadata and passwd-name data. Native custody has separate
owned-file/replacement/finalizer tests and an explicit readonly real Nix profile
qualification, including accepted dot/repeated/trailing separator spellings.
Neither these tests nor label equality establishes actual engine readiness.
