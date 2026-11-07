# Guest memory capsule build

This Linux build-time producer assembles an **unselected** fixed-purpose image
tree at `/opt/reverie/memory`. It does not install an image, create an employee,
publish a memory context, authenticate a caller or grant access to stored data.

The two public entry ELFs are built with the static musl platform. They remove
loader/Node autoload settings before starting the fixed relocated Node binary;
sanitizing in a dynamically linked entry would happen after its loader ran.
The guest build purpose is compiled into the native code. Host Nix bindings
and host Console defaults remain separate. There is no runtime program, prefix,
manifest, PATH or environment selector for this purpose.

The complete qualified Console module tree is retained, including licenses and
all 66 native assets. The supported execution roots are Node and the node-pty
addon imported by the fixed journal CLI. All other development, rendering,
browser, Bare and foreign-platform ELF assets retain their original bytes and
receive explicit inventory classifications. Unclassified ELF assets or a
missing/wrong-architecture required addon refuse the build. Remotion is used
only by the development video scripts; it has no `apps/web/src` imports. Actual
qualified bootstrap/CLI imports load no renderer/build/browser bindings and
load only node-pty for the CLI. This purpose does not add general Console web,
rendering or browser execution support. Existing third-party development
scripts are inventoried rather than described as having disappeared.
The sealed native-asset fixture binds this classification to the qualified
x86-64 Console, its package/lock hashes and each asset package's metadata.
New platform/package spellings require review rather than implicit adoption.

The producer resolves the native ELF roots' transitive dependencies against
their original RPATHs and the supplied complete Nix closure. Conflicting
same-basename library contents refuse the build. Each distinct resolved source
is traversed even when its bytes match an already selected library: its
original `$ORIGIN` can resolve a different child dependency. An immutable
two-origin fixture checks that a conflicting child cannot be hidden this way.
Maintained `patchelf` owns
interpreter/DT_NEEDED/RPATH edits. The selected loader remains structurally
untouched; equal-length original `/nix/store/` optional-loader strings become
`/opt/rvmem/`, an immutable absent image slot. The system preload pathname is
likewise redirected, at equal length, to `/opt/rvmem/preload.off`; environment
filtering alone cannot suppress that loader hook. The owning loader control
compares actual original/changed loader bytes with a synthetic preload file
still present, without executing an injected object. Selected dynamic runtime
ELFs receive the fixed library search path and `NODEFLIB`. The entire output becomes
non-writable. Build inventories retain source and result hashes.

The real Console uses separately imported TSC modules. The guest composition
compiles the exact bridge and a fixed guest-origin module using that qualified
Console's TypeScript dependencies and normal strict compiler options. It copies
these real modules at their import paths; it never patches `index.js` text or
pretends that an inlined bundle imported an overlay. The base Console's embedded
route handler retains its original source provenance. Node's documented
[`--no-global-search-paths`](https://github.com/nodejs/node/blob/v22.23.3/doc/api/cli.md#--no-global-search-paths)
prevents CommonJS HOME/NODE_PATH fallback while preserving packaged addons.
The guest entry also removes `NODE_COMPILE_CACHE`: the fixed modules must not
retrieve persisted V8 code from a caller-selected writable directory. The
namespace control requires the same Node to enable that cache when run directly
with the setting, and requires the fixed entry to leave it absent.

The optional image input copies actual files with root ownership outside the
employee's writable `/nix`. Existing launch configuration can still select
mounts overlapping `/opt`; adoption must reject overlaps with both capsule and
absent fallback locations at the genuine Created/Started launch boundary.
Filesystem checks establish installation data, not process attestation: a guest
can run other programs. Authorization remains the actual fixed-session Office
transport and canonical current-employee/service-grant API checks.

Actual non-root namespace, immutable-loader/module, environment injection,
protocol/API and existing-data controls must qualify the resulting artifact.
The real Created/Office context publisher and final image selection remain
separate unmet integration requirements until their genuine owners consume it.

Explicit initialization publishes `initializing`, `profile-pending` and `ready`
states, so it may rewrite the two new private readiness marker rows. The owned
fixture compares complete schema/cells/BLOBs and preserves all existing record
IDs and implicit rowids; only those exact two newly introduced marker rowids
are normalized when comparing repeated mutating initialization. Read-only
recall still requires byte-identical database, profile and configuration.
The nonempty fixture was created by unchanged legacy Python APIs using the
real hashed embedder, with synthetic IDs/claims/history and unknown extension
data. It contains no pre-existing native readiness keys. Historical collisions
with those keys and malformed readiness records require separate qualification
and refusal before any general existing-instance migration claim.
