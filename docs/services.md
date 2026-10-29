# Reverie service setup

Choose one website deployment. Native `reverie service` manages the existing
website job; a container deployment uses its existing engine lifecycle instead.
Do not install a second native website beside a running container. Both can use
the separately installed existing isolated-laptop broker on supported local Linux.
No command below requires editing a personal NixOS repository or rebuilding the
host. Source examples are not activation of a particular private installation.

## Native website

On a supported Linux Nix host:

```bash
nix profile install .#default
reverie service install --host 127.0.0.1 --port 3000
reverie service status
reverie service stop
reverie service start
reverie service logs --lines 100
reverie service uninstall
```

The existing service uses a systemd **user** unit on Linux or a per-user
LaunchAgent on macOS. The CLI's native macOS support does not imply these
Linux-only flake outputs or isolated-worker backend work through Docker Desktop.
Installation refuses an active native unit or an unmanaged website answering at
the same address. Stop and review the existing deployment before replacing it.
`start` and `stop` control the installed website unit; they do not toggle employee
desired-running or vacation state. Uninstall removes the service, preserving data.

Linux starts the enabled unit with the user manager, normally at login. Keeping
it after logout or starting before login requires an owner-selected linger policy.
Installation only reads that policy; it never silently enables it or requests
sudo. Inspect with `loginctl show-user "$USER" --property=Linger`. If needed, an
owner can separately enable linger using the host's ordinary authentication.
The macOS LaunchAgent starts in the user's login domain, not as a system daemon.
Native service logs are bounded by `--lines`; direct journal/tail commands can be
used for an owner's interactive follow session.

## Container website

For a new reviewed deployment with a running owner-selected engine:

```bash
nix run .#start
```

This is the existing container launcher, not a native website-service install.
Retain and review `deployment.json`; select the configured container name for
normal engine `start`, `stop`, `inspect` and `logs` commands. The launcher uses
`unless-stopped` for the website. An explicit stop stays an owner stop under that
policy. Container removal is not service uninstall: preserve every data/project
bind and reviewed recovery receipt before any recreation. Do not use engine
access as a substitute for host administrator authentication.

## Isolated laptop broker

The Reverie-owned helper manages the existing `reverie-worker-broker.service`;
it does not create another website supervisor. The owner first selects an
existing private broker configuration with durable storage and **admission**
resource policies. It is not generated from an employee request.

```bash
broker_config="$HOME/reverie/runtime/worker-isolation/broker.json"
nix run .#worker-service -- --config "$broker_config" check
nix run .#worker-service -- --config "$broker_config" install
nix run .#worker-service -- --config "$broker_config" start
nix run .#worker-service -- status
nix run .#worker-service -- logs --lines 100
nix run .#worker-service -- stop
nix run .#worker-service -- uninstall
```

The first command checks ordinary-owner Linux, the local Unix-socket engine,
cgroup-v2 RAM/no-swap/PID capability, finite admission policies, host/website
headroom and private durable roots. Unknown or unsupported capability refuses;
there is no unlimited or privileged fallback. Docker Desktop and remote engine
transports are not supported by this host-proc/cgroup backend. Read-only declared
capability is not installed acceptance: independently verify actual kernel limits,
exact mounts and the approved image/security profile after installation.

`install` writes the owner-private config selection, links the exact packaged
unit, retains its transitive Nix closure with a durable owner GC root, and enables
it **without starting it**. It refuses an active broker, a foreign
unit or a different retained config selection; preserve and review those instead
of silently replacing them. `start` repeats capability checks. The same checks run
in the existing unit's `ExecStartPre`, including at login/boot, without waiting on
the target starting them. An empty cleaned disposable root can be recreated
privately on the next laptop creation; missing durable state refuses. Broker start can
recover existing running laptops, but does not wake stopped employees. Stopping
the broker interrupts viewers/phones and needs ordinary coordinated transport
maintenance. Stop/uninstall remain possible when the engine is unavailable.
Uninstall removes only the recognized service link and its service GC root, leaving private configuration,
homes, stores and intent intact. No engine socket or host key is given to a laptop.

Both multi-user Nix (root-owned store files) and ordinary single-user Nix
(owner-owned store files) are supported. The exact packaged unit path remains
pinned and group/world-writable or foreign-owned units are refused. Private
configuration paths preserve spaces, UTF-8 names and literal backslashes; startup
must use the same installed selection that passed validation.

Broker login/linger semantics match other user units. Laptop containers themselves
deliberately have no blind restart policy. Preserve employee OFF/vacation settings
through install, boot and diagnostics. Starting a website or passing a Nix/SSH/
Docker diagnostic is not permission to start a paid model conversation. Normal
same-conversation recovery requires the current owner intent and authorization.

Use project flakes (`nix develop`, `nix build`, `nix run`) first, `nix shell` for
temporary tools and `nix profile install` for persistent tools. Keep the base lean.
Private home/settings and `/nix`, durable projects and retained results survive
recreation; `/tmp/<project>` build/cache/download data are disposable. See
[laptop storage](portable-laptop-storage.md) and the handbook for storage boundaries.

### Same-config broker transport upgrade

A different immutable broker generation requires an explicit owner maintenance
window. `install` continues to refuse an active/different generation. The fixed
transport upgrade changes only the recognized user-service unit and its service
GC-root link. It does not rewrite configuration, environment, reservation marker,
profiles, operation history, grants or limits, and never sends a laptop stop,
create, wake or provider launch command. It is separate from GPU first installation.

Use the reviewed **new generation's** `worker-service` flake launcher. Select a
fresh canonical owner-only operation directory on the same filesystem as the
installed unit/configuration, outside every laptop/container mount. A private
0600 selection file has exactly `{"providerPIDs":[...]}`: the complete current
provider PIDs from the owner's read-only continuity baseline, not commands or
permission claims. Each supplied PID must still belong to an observed running
managed laptop, with unchanged birth, executable, root and namespace identity.
The helper does not claim that a supplied PID list discovers omitted providers.

```bash
nix run .#worker-service -- --config "$broker_config" --diagnostic \
  prepare-transport-upgrade --operation "$upgrade_operation" --selection "$provider_selection"
nix run .#worker-service -- --config "$broker_config" --diagnostic \
  apply-transport-upgrade --operation "$upgrade_operation" --plan-sha256 "$prepared_plan_sha256"
```

Preparation writes a finite ten-minute plan without service effects. Apply has a
single 180-second budget and durable one-attempt latch. It requires the current
canonical reservation domain, sufficient actual headroom, no retained resource
operation and a valid settled/absent host-job fence. This installed operation
schema has no released operation state; `VERIFY_RECORDED` still retains a claim.
An installed protected terminal/resource actor requires its separate coordinated
maintenance path. Unknown or changed facts refuse; they never become capacity
credit, authorization to clear a fence or permission to provision/reset a domain.

The old and new closures remain pinned. Apply stops only the recognized broker,
proves it exited, replaces the two generation links by CAS, then starts the new
broker and verifies its actual immutable source/program and private phone peers.
All laptop CIDs, provider births, canonical storage roots and owner intent must
remain unchanged. Phone/outer terminal transports disconnect during this window;
reattach them using the supported existing-only path after continuity checks.
Do not recreate a provider to repair an outer pane. Coordinate the window to
exclude new work/launches; this tool does not make unrelated owner operations
atomic with the whole upgrade.

Final content reads and descriptor cleanup finish before the last live-process
checks; physical roots and static file/link checks follow those process reads.
A late refusal leaves the attempt retained and never publishes `DONE`.

Any consumed failure retains its attempt, step intents and both generations;
there is no automatic retry or rollback. Inspect and reconcile those facts before
any later operation. A source test or prepared plan is not an installed transport
acceptance, active GPU proof or permission to run a workload.

### Coordinated website writer pause for a transport-only upgrade

When website recovery counters churn the whole company file, do not drop those
fields or weaken a consumed attempt. The opt-in host-only
`reverie.worker_transport_maintenance` controller can quiesce only an explicitly
selected existing website incarnation while the unchanged strict transport helper
prepares and applies a **fresh** operation. It never starts, recreates or restarts
a website/provider, changes policy/grants/limits, or accepts a failed broker stop.

This is an ordinary owner-local deployment tool, with no HTTP endpoint or new
capability authority. All instance selection belongs in a separate private closed
policy outside Git: exact website CID/image/init PID/birth, local engine, config,
complete current provider census and owner projection, old/new immutable unit
records, selected immutable tool paths/hashes, and fresh control/helper directories.
The policy must name a fixed **private 0700 source-copy closure**, not a normal
0755 checkout or root-owned immutable source directory. Copy the qualified helper's
complete Python package source closure from its immutable source plus the reviewed controller;
retain only regular singly linked owned files, preserve required subpackages (including `cleanup`), pin every recursive `.py` byte, and use
canonical private parents. The current source validator rejects symlink/hardlink
substitutions and undeclared recursive Python files. Initial native custody checks all
program/policy/control/evidence roots against every actual/configured bind,
including broad, read-only, stopped and aliased mounts. UID/0600 alone is not proof.

Invoke the exact reviewed private entry with the pinned interpreter and isolated
Python options, after review and fresh binding; no effect happens merely by import:

```bash
"$python_tool" -I -B "$private_entry" --execute \
  --policy "$maintenance_policy" --policy-sha256 "$maintenance_policy_sha256"
```

The controller retains one durable attempt before arming a separate unpause-only
watchdog. Work is bounded to 240 seconds; the watchdog recovers the same CID/image/
init birth on channel loss or at 270 seconds, with a bounded recovery client. The
existing 600-second office outage grace is unchanged. Whole protected snapshots,
including the full company file, must match before/after pause and preparation.
Only the exact closed prepared generation/config/native/provider plan is applied.
Policy expiry is rechecked at effect fences; recovery unpause remains allowed after
expiry. Mutating helper clients run in an actual owned session: group cleanup and
reaping precede ordinary unpause/cancellation; partial or unconfirmed settlement
cannot publish success. Only fixed helper diagnostic categories/reasons and output
lengths/hashes are retained, never raw stderr/config/credential bodies.

The recovery timer guarantees neither broker completion nor rollback. On parent
loss it may resume the writer while a previously issued backend action is still
unknown; retain all helper/controller attempts and reconcile actual facts. Any
failure unpauses only the same observed website incarnation and cannot produce
`DONE` through a late descriptor/fsync failure. Normal completion publishes its
last rename only after finalizers and final expiry/static checks. These source and
owned mock-OS tests are not installed/native acceptance; a coordinated owner window
and independent native provider/config/website postchecks remain required.

## Optional protected container website

For a **new, separately reviewed container deployment**, set the strict boolean
`"protectedWebsite": true` in the owner-selected `deployment.json` before using
`nix run .#start`. Omitted or `false` preserves the ordinary launcher and its
existing deployment signature. Changing the selection never replaces an existing
container: preserve its data and use the normal reviewed replacement workflow.
The launcher refuses reuse if the selected protection is missing or unknown,
even if the deployment label matches.

This profile uses a read-only image root, drops all capabilities, adds
`no-new-privileges`, and keeps private PID/default engine seccomp and private IPC
namespaces. Writable `/tmp` (256 MiB) and `/run` (16 MiB, owned by the selected host
UID/GID) are private tmpfs mounts charged to the existing website memory limit;
`/run` is non-executable. Existing explicit data, home, workspace, scratch,
project and optional control-directory binds retain their selected access.
No host Nix store, daemon, service configuration or new host privilege is added.
Reuse rejects Nix-path masks/binds and loader/interpreter override environment.

This is only a container startup profile. It does **not** install an owner
terminal/resource actor, grant capabilities or provide protected-channel custody.
Actual image startup, provider installation, tmpfs/kernel limits, full mount and
HostConfig/entrypoint verification, and fixed trusted bootstrap acceptance need
separate native qualification before those optional backends can become ready.
An ordinary current website is not retroactively protected by this source flag.

The existing `reverie-update` helper preserves only this exact pair of bounded
tmpfs mounts and security settings when the same durable selection is enabled.
It refuses unknown temporary mounts, sizes, UID/GID, modes, loader overrides or
protection; changing the selection does not silently enable or disable it. After
the build it rechecks the current configuration, mounts and limits before stop.
The existing isolated-worker refusal remains: paired broker/website or protected
bootstrap changes still require their separate reviewed update workflow. Do not
remove security settings or temporary mounts to bypass a refusal.


The isolated interpreter qualifier anchors its own unreaped child's birth before
waiting for the fixed metadata READY. It reads the complete root, namespaces,
executable and argv only after READY, preserving all declared-file pins and the
absolute deadline. A transient pre-READY wrapper exec is not a new process or
permission fallback; a permission failure after READY still refuses qualification.
The Nix Python checks exercise this with an inert immutable C wrapper and actual
owned child procfs permissions, including failure and cleanup schedules.

For future explicit transport calls, `--diagnostic` also reports an allowlisted
`POSTSTART_*` stage on post-start failures. It never prints paths, command output
or exception text. Nonzero status, retained attempts, unknown outcomes and no
automatic rollback/retry are unchanged. These diagnostics cannot identify the
historical cause of an earlier attempt that did not record its stage.
