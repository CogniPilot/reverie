# Build-only policy artifacts

`reverie-policy-artifacts` is the Nix Docker namespace and task-v1 seccomp artifact producer. It is
not installed in the server runtime and is not an owner configuration or
deployment interface. The existing GUI/API and broker continue to own those
operations. `--help` describes the fixed outputs, accepted target systems,
build-only input paths and failure behavior.

`--verify-manifest FILE` is a read-only native acceptance mode. It reuses the
same Contracts manifest/hash/exact-derivative checks and bounded checked-close
reader, then prints exactly the selected profile path (no newline or trimming).
It is mutually exclusive with output-producing modes. This validates artifact
DATA; the developer still selects the actual Nix-built package. It proves no
installed custody, employee permission or deployment/host readiness.

`--docker-profile-output FILE` selects the Docker mode and excludes task-perf
output-directory/system flags. The Contracts `docker_profile` owner preserves
the pinned Moby default-deny document and appends exactly the original seventeen
namespace calls. It adds no keyctl, BPF, perf or general syscall permission.
The original string-JSON semantics and sorted, default-spaced ASCII bytes plus
newline are preserved, including unknown fields and last-key-wins decoding.
Repeated input rules retain the original append behavior. This produces profile
data; kernel ownership/capability checks and installed policy remain separate.

The executable delegates policy, whole-base derivative, JSON bytes and hashes
to `reverie-contracts::task_perf_v1`, which in turn uses the checked core rule.
It writes the same sorted, default-spaced ASCII JSON plus newline as the legacy
producer. Only the seven existing manifest fields are emitted. The declared
paths are build data; installed observation separately proves canonical Nix
paths, actual system, custody, both raw hashes and the derivative.

Input and output are bounded to the installed reader's 65536-byte limit. Existing
output leaves and symlinks are refused, never truncated. Each opened descriptor
is closed once with errors checked; both primary and close errors survive.
Failed builds can leave partial, unpublished files. Nix publishes only a
successful derivation; the program never cleans or adopts another build's data.

`nix/policy-artifacts.nix` projects the three actual crate inputs and the
transitive Cargo lock closure. Unrelated workspace members, lock entries, host
code and website files do not change this producer's identity. Changes to an
actual policy/producer dependency or toolchain intentionally do. The initial
Rust migration changes the output store pathname; profile bytes, raw hashes,
manifest schema and location-dependent manifest formatting remain compatible.

Docker build inputs/outputs also have the existing installed-reader 65536-byte
bound. The original Docker producer was unbounded and overwrote its output;
exclusive output creation and the explicit bound are deliberate build safety
changes. The pinned upstream and generated profile fit those bounds. No claim
of equivalence for every arbitrary legacy CLI input follows.

The eleven Docker oracle vectors came from the unchanged original producer at
`541f88e6` (source SHA-256
`6e79a25e7cbe984c8e3d9d9a550cdecefb0b465c3ac030add02a2f1b94eb811f`).
The Python Docker producer was retired after independent source review and
byte comparison of the actual pinned upstream's packaged Rust output.
They cover accepted bytes and refusals, existing denials, unknown fields,
duplicate keys, non-finite/float values, surrogates and UTF-8 BOM handling.

The old `nix/worker-perf-profile.py` was retired after byte qualification against
its historical source at `77c4c1a7`; sealed oracle fixtures and receipts retain
that provenance. The current Python broker still needs migration. Nix's
third-party TOML generator and other build
tools can themselves use Python; this cohort removes the selected first-party
policy producers, not every build-time interpreter. No deployment, engine
operation, perf syscall or service-runtime Python removal is claimed here.

`codex-observer-inputs source|vendor ROOT PROVENANCE GIT_HASHES` qualifies the
optional diagnostic candidate's public build inputs. It preserves the reviewed
lock hash, Git revisions and output hashes, registry checksums/count, patched
source hashes and complete vendor crate inventory. Vendor configuration must
still select `vendored-sources`. It runs no program. The Nix wrapper separately
runs locked, offline Cargo metadata and passes its completed JSON through
`--cargo-metadata FILE` to the vendor report. The original sorted, spaced report
format is retained, and `nativeBuildOrRuntimeAcceptance` remains false.

The new read bounds are 32 MiB for the lock, 2 MiB for provenance/hash/config
documents, 8 MiB per patched file and 16 MiB for Cargo metadata. Patched source
paths must contain only relative normal components, with no symlink leaf.
These are build input checks, not an owner workflow or a running Codex check.

The old `nix/codex-observer/verify-inputs.py` and Nix's inline Python report
amendment are retired. The selected native source/vendor producers qualified
the current pinned inputs: eight Git sources, 1,296 registry packages and 160
workspace members in locked, offline Cargo metadata. The original source code
was reviewed for report-byte compatibility; no legacy Python comparison run
or Codex native/runtime acceptance is claimed.

`idmap-image --shadow PATH --closure PATH --patchelf PATH --readelf PATH
--output PATH` delegates the fixed two-helper image prefix to the shared Rust
ELF bundler. It uses declared Nix build inputs and a fresh output root. Neither
helper is executed; no user/group mapping, file capability or setid grant is
performed. The existing image factory still owns capability installation.

`website-image-provenance --archive PATH --console PATH --node PATH
--client-manifest PATH [--program-manifest PATH] --output PATH` replaces the
website Nix provenance producer. The build-only reader derives Nix namespace
ownership from the actual root/store, checks immutable file identity and closes
every opened input/output with errors retained. Contracts owns the lossless
v1 metadata, complete Config, native-client schema, optional startup graph,
aware creation timestamp and sorted compact ASCII encoding. Raw Node invocation
and resolved executable remain distinct. No image member is executed or
extracted. This neither loads nor deploys an image, proves layer contents or
privacy, grants authority, nor changes an installed runtime.

Inputs retain the original 16 GiB archive, 64 GiB expanded stream, 4 MiB JSON,
4,096 logical member, 256 MiB per-code-file and optional 512 MiB code-graph
bounds. One 300-second deadline covers all reads. Streaming passes bound memory
without retaining every configuration or any layer. Before logical tar parsing,
a raw pass limits GNU/PAX extension records to 4 MiB each and 8 MiB total.
This fixed-factory reader accepts plain/gzip archives, rejects sparse/global
PAX records, size-changing PAX and repeated PAX keys; the old general Python
archive API could accept additional formats. Those are explicit build safety
restrictions, not a claim of compatibility for arbitrary legacy CLI inputs.

The Python website provenance module remains for active worker provenance and
resource-actor helper imports, as well as historical factory source pins.
Moving the selected website build invocation does not retire those consumers
or remove all build-time/service-runtime Python.
