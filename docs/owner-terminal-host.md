# Optional protected human terminal

This is a separate owner terminal inside a selected laptop. It does not send
keystrokes to the employee's provider session. Organizational titles do not
provide access. The normal owner login, exact origin/transport, current employee
binding and an explicit private installation entitlement must all agree.
Without the optional native installation the route returns unavailable.

The existing R2 `ownerTerminalCore` remains inert. The optional
`ownerTerminalHost` package adds a protected host service, an early website
entrypoint and a static guest toolkit. The optional `ownerTerminalImage` retains the normal Docker entrypoint and selects
the fixed Python launcher as Cmd. Its `libexec/reverie` basename preserves the
normal entrypoint web/helper recognition without replacing the normal CLI. `ownerTerminalWebsiteManifest` (also
`ownerTerminalHost.websiteManifest`) emits
`share/reverie-owner-terminal/website-program.json`. It contains canonical ELF and
exact invocation/argv bindings plus byte/size hashes of declared startup files;
it is fact-only and does not attest owner authorization or installed acceptance.
An independently qualified whole-image/archive proof still covers the remaining
immutable application closure. Building the package does not install or
start anything. Root-owned static ELF copies of the monitor and Bash are placed
at `/opt/reverie/human/bin` in newly built worker images, outside writable `/nix`.
Both binaries are checked for absence of an ELF interpreter or dynamic library
requirements. Existing laptops are not modified or automatically restarted.

The owner prepares and reviews a fresh private installation namespace. Keep a
normal durable Nix build out-link for the complete optional package and the
qualified worker/website images; do not rely on a disposable build directory as
a permanent GC root. The unit installer does not build images, add mounts,
replace the website, enable/start a service or wake a laptop. These are distinct
reviewed owner operations. A supported installation needs a new website using
`libexec/reverie`, plus the exact read-only bootstrap mount;
an ordinary already-running website cannot enroll itself. Keep the normal
Docker entrypoint so its existing data/auth/account preparation is preserved.
Its previously forked helpers cannot inherit a socket created later by the Python
bootstrap; the fixed Node wrapper connects before importing the application.

The private `Installation` document has a closed schema in
`python/reverie/owner_terminal_native.py`. Its three pre-existing private
owner-only physical directories are `controlRoot`, `bootstrapRoot` and
`ledgerRoot`; each must be disjoint from every laptop grant and live container
bind, including mount aliases. Control and ledger roots must be durable, outside
disposable/runtime filesystems. Bootstrap is the only root exposed to the
website, read-only at `/run/reverie-owner-terminal`. Neither control, ledger nor
the private worker policy may be exposed to that website. The file itself must
be private mode 0600 and live directly in `controlRoot`.

The document fixes the engine socket inode/ID, exact raw worker-config hash,
public static-toolkit manifest, immutable host entry and engine executable,
explicit EID→SID/generation entitlements, origin and actual ingress peer tuples.
`website` uses the non-authorizing `WebsiteFacts` selection schema: full Config,
HostConfig and complete Mounts digests; exact image/init incarnation; immutable
host code byte/size manifest; and fixed bootstrap/Node argv. Source/package and
archive provenance must establish the complete declared module closure. Guest
image-copy inodes are qualified separately against those immutable host bytes;
canonical executable and exact symlink invocation are different facts.

The optional website must have a read-only root, private PID namespace,
CapDrop=ALL, no added capabilities and no-new-privileges. No mount may mask its
Nix code. Loader injection environment is refused. These requirements are not a
claim that an existing deployment already qualifies. The worker toolkit also
requires a read-only image root, private PID namespace and protected toolkit and
proc paths; an older image without it remains unavailable.

The fixed `scripts/reverie-owner-terminal-host --policy PATH --install-unit
--launcher IMMUTABLE_LAUNCHER` operation writes one exclusive ordinary-user unit.
It neither repairs existing directory permissions nor overwrites a previous
unit. The unit has 256 MiB/no swap/64 tasks, no automatic restart, private tmp,
read-only home/system and write access only to the three private roots. Review
and activate it separately. The host does not accept arbitrary shell/program
selectors or a worker-provided actor choice.

A single host event loop owns the actual SO_PEERCRED/SCM_CREDENTIALS and pidfd
channel, all ledger operations and all H/PTY operations. Python bootstrap must
exec the same immutable Node incarnation over the existing two-stage protocol.
Every owner request is challenged against the real live account and current
native laptop; the host separately resolves canonical company storage, EID/SID/
generation, current intent, image, policy labels, complete mounts and init start.
The host holds original init-root, host home/nix and guest bind-root directory
FDs. Source spelling is insufficient: current host and guest directory dev/inode
must still match those held originals. Path replacement, changed guest bind or
unknown metadata refuses; directory contents/mtime alone do not change identity.
Root snapshots stay in the private issued binding and are rechecked through GO,
input and settlement. A same-CID/new-init or rebound-root change cannot consume a
previously issued capability.
HTTP→WebSocket handover authenticates the new actual request without changing
owner scope, target or absolute expiry. Logout closes the tracked actual socket.

After durable one-use consumption, the host records an exclusive launch intent,
local client incarnation and kernel-verified guest monitor. The static monitor
sets dumpable=0 before readiness and does not fork a shell until a private GO
bound to its verified current namespace. The shell receives only its PTY and a
fixed cleared environment. Input/output/resize are bounded framed operations;
PTY text is never a control or cleanup receipt. Native monitor/control FDs are
closed before shell exec. Browser desktop and mobile use the same owner-only
WebSocket and never receive a native proof, executable selector or credential.

EOF, owner loss, expiry, website death and shutdown close the native channel and
attempt physical cleanup. Positive settlement requires the monitor's nonce-bound
receipt, subreaper ECHILD plus empty bounded descendant inventory, exact client
exit, and independent kernel absence of the captured guest incarnations. A parent
exit or disconnected WebSocket alone is insufficient. Unknown outcomes retain
consumed ledger/intent records and forbid replay; no restart revives handles.
External jobs delegated to unrelated daemons are outside the PTY descendant
settlement claim. Source bounds do not make uninterruptible filesystem I/O a
hard deadline.

The R2 operation/entry limits remain intact. Polling is once per second; this
channel is finite and does not automatically renew or reconnect. Private records
contain identity/status metadata and hashes, never terminal input/output, owner
cookies or reusable native proofs. Installed host/worker/owner-browser acceptance
is required separately; source tests and owned PTYs do not close that requirement.
