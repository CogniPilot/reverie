# Worker validation ownership audit

The envelope remains intentionally partial. The later
[ordered application validator](../../../reverie-application/src/worker_validation/README.md)
now composes the remaining purpose owners, actual readonly observations and
named compatible owner-file loader. The historical list below records what
this envelope cohort alone established; it is not a full-validation token or a
claim that a production consumer has switched.

Frozen source: `python/reverie/worker.py::load_config/validate_config` and
`worker_docker.py::{enabled,require_immutable_mounts,require_account_mounts}` at
`26abbc0e`. This cohort ports the complete pure envelope/base and mount
declaration unit, plus the complete pure immutable/account target bodies. It
does not replace the worker validator or select a Rust product consumer.

`WorkerEnvelope` retains the original `EffectiveWorkerConfig` without defaults,
normalization or a JSON clone. It checks the exact 22 required and 17 optional
keys, Python numeric equality of version to 1, base identity/image, strict UID,
GID and worker count, existing strict resource policy, exact cgroup parent, six
absolute non-NUL string paths, socket UTF-8 byte limit, maintenance session list,
and explicit lexical mount declarations. Maintenance and mount lists have no
new count limits. Nil/duplicate maintenance SIDs remain accepted. Non-socket
paths and mount targets retain Python codepoints, including lone surrogates.

General destinations intentionally allow `/proc/sub` and `/home/agent/sub`,
while banning the exact protected locations, attachment subtree and existing
run-directory exceptions. Source declarations retain accepted `//`, repeated
separator, dot and trailing separator spellings. They establish neither source
existence, resolved identity nor safe host exposure. Typed `WorkerPath` getters
return the six original captured base paths for the native observation owner.

`validate_feature_policies` borrows the same captured data and invokes existing
GPU, memory, resource-map, perf and lease owners. Memory validation uses key
presence, not effective-projection truthiness. Borrowed perf/lease entry points
share their existing implementation. This method does not validate remaining
optional domains, seccomp or host mount sources and creates no full-validation
token. Its grouped pure order does not claim the original first-error ordering.

Core `MountTarget` owns canonical POSIX target and overlap rules independently
of the build OS. Its character acceptance matches pathlib, rather than a host
safety claim. `require_immutable_mounts` implements protected overlap, exact
readonly destinations, writable project rules and disjointness.
`require_account_mounts` implements strict account descendants and disjointness:
the caller still needs actual enabled-rootless qualification. These pure bodies
neither inspect seccomp nor grant a mount/start capability.

## Original ordered checks and remaining owners

The original validator returns the same object and inserts no defaults. Its
order matters when integrating the remaining native service. This is an
execution audit, not a second definition of the rules:

1. Envelope/version, then optional soft helper socket pathlib spelling.
2. Memory feature on either key's presence; reservation option validation.
3. OPS path shape and actual private broker binding custody.
4. Browser and resource-actor absolute paths plus non-strict resolution.
5. Command telemetry catalogue and GPU maps.
6. Perf map container, then nonempty task-v1 validation; resource maps; rootless
   enabled validation including actual seccomp observation.
7. Optional private goal path rule.
8. Base identity/image, strict integer/resource bounds, CPU/cross-pool budget,
   cgroup parent and budget mode.
9. Six path strings, maintenance sessions, UTF-8 socket byte bound.
10. Explicit mounts, each declaration/destination immediately followed by strict
    source resolution and source/control-root exclusion.
11. Workspace attachment real-directory observation, then both resolved and
    lexical overlap checks across all sources and destinations.
12. Non-null lease validation; cold-temporary policy and path resolution.

OPS custody reads additional protected config/key paths and checks exclusion
from mounted/source/account roots. Browser/resource-actor and cold-temporary
paths use actual non-strict resolution, permitting nonexistent tails; lexical
checks cannot replace those observations. Cold policy also compares resolved
mount sources. Mount validation interleaves pure and native checks: declaration
capture does not establish its first failure or native evidence lifetime.

Rootless absent/null bypasses validation. Non-null options require exactly three
keys and literal-bool enabled; disabled options leave profile/digest arbitrary.
Enabled options additionally require immutable Nix seccomp custody, hash, parsed
profile/default action and applicable syscall checks. Those facts are absent
here. Reservations, telemetry, goal paths, rootless option gate, helper socket
and cold-policy shape remain explicit future pure work. Existing host lease ELF,
device and perf observations remain distinct from schema, mounted/kernel proof
and effect authority.

## Loader compatibility and evidence

`load_config` checks a named owner-only regular file, then calls
`json.loads(path.read_text())`. It accepts last-key-wins duplicates before schema
validation and does not establish stronger FD/ancestor custody. The worker hash
decoder rejects duplicates and expects UTF-8 captured object data. It is not a
drop-in raw loader replacement; selecting it as one requires an explicit
compatibility decision. Dormant nonfinite data are not globally banned.

The inert JSON fixture records 44 actual `worker.validate_config` cases using an
owned temporary source directory, without patching validation, and 67 actual
`require_immutable_mounts` cases. Stored source paths are synthetic. Rust compares
acceptance and exact retained encoding, including bool/float versions, signed
CPU zero, arbitrary disabled seccomp data, surrogates, duplicate maintenance IDs
and destination aliases. Additional tests cover account boundaries, retained
source aliases and shared feature refusals. This establishes no installed
readiness, existing company migration, authorization or consumer cutover.
