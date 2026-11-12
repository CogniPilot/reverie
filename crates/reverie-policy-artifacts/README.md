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

`nix/policy-artifacts.nix` projects the four selected crate inputs and the
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

`worker-image-provenance --archive PATH --source PATH --profile PATH
--toolkit-manifest PATH --output PATH` replaces the worker Nix provenance
producer. It reuses the same retained immutable-input and metadata readers,
the lossless v1 codec and existing worker factory validation. It additionally
hashes the complete original compressed archive and each complete raw layer
stream, including tar padding and bytes after logical EOF. An additional pass
checks nested layer extension bounds before any logical nested tar iterator.
The original two-million-member budget is shared across layers; each layer
retains at most 4,096 selected whiteout/path events. Layer whiteouts apply to
lower state before ordered additions, and final toolkit paths must remain
direct root-owned regular 0555 files under protected directories.

The shared ELF bundler validates all ELF64 program/dynamic headers, target
machine and bounds, requires a load segment and rejects interpreters and
dynamic dependencies. It executes neither terminal program. The Nix producer
still writes worker-image-provenance-v1 plus the existing native-child annex.
Its eleven source pins remain the exact legacy v1 selected-factory inputs,
including the old Python files. Those files cannot yet be deleted. This pin
set is not complete Rust source provenance; qualification must separately bind
the exact Rust source, tool ELF and selected Nix factory. Native runtime image,
custody, canary, resource, ownership and consent checks remain unchanged.

`human-terminal-manifest --root PATH --system SYSTEM` replaces the inline
Python manifest generator in the static human-terminal toolkit recipe. It
accepts only a canonical direct Nix-store build output with builder-owned,
protected directories and the exact two expected regular 0555 program files.
Builder identity comes from the actual effective UID. This fresh-output reader
is separate from the immutable-input reader's namespace/store-owner policy.
Input files are bounded to 16 MiB and checked against retained descriptor/path
identities; all static ELF validation uses the shared parser. Input file closes
finish before exclusive manifest creation; retained directory closes also have
checked outcomes before the Nix derivation may succeed. Neither program runs.

The manifest keeps the existing three fields, fixed guest paths, raw hashes and
lengths, compact sorted ASCII bytes and newline. The C source/compiler flags and
readelf checks remain in the same Nix recipe. Worker runtime composition selects
the toolkit recipe from its declared artifact source, with the original runtime
source supplying C bytes and the same selected check policy supplying the tool.
An explicitly older artifact-source recipe retains its original argument shape
and implementation; the current recipe and default selection use Rust.

`worker-resume-program --console PATH --node PATH
[--owner-terminal-program PATH] --output PATH` replaces the Nix resume-program
manifest producer. It records every console file, empty directory and symlink,
plus the resolved Node file while retaining its original invocation spelling.
Regular files keep their raw SHA-256, byte count and permission mode. Symlinks
keep their raw target spelling, are never traversed, and must resolve inside
the console; directory inventories, link resolutions and full metadata stamps
are checked again before output. Immutable namespace/store ownership remains
separate from the toolkit builder's fresh-output UID policy.

The v1 document retains the four ordered startup argument vectors, Python
codepoint ordering and compact ASCII encoding. Bounds are 65,536 total graph
entries, 2 GiB of console/Node file bytes, 256 MiB per file and 16 MiB of encoded
manifest. Byte and encoded-output budgets are checked incrementally. The final
entry count now includes Node and pending empty directories; the old producer
could undercount those, while its runtime peer already rejects an oversized
final graph. These are closed build safety checks, not a partial file subset.

Optional H selection separately validates the existing generic startup graph,
exact protected web/Python arguments and config pathname, aliases and all raw
code hashes under its original 512 MiB graph budget. It adds only the existing
`ownerTerminalProgram` reference to the resume manifest; external H code is not
merged into console files. The config pathname is data and is never opened.
The shared POSIX filename codec preserves surrogateescape bytes. No program,
interpreter, website or worker executes. Python runtime peer imports remain
active, so the Python module cannot yet be deleted.
