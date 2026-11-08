# Docker worker pool (unselected)

This is an unfinished lower controller owner, not an executable fleet rollout.
It does not provide Q authorization, the retained provider-maintenance fence,
controller policy publication/activation, a controller listener, leaf policy
application, or an installed-pool proof to the broker over a socket.

The Docker-only purpose preserves the registered `<deployment>-workers.slice`
spelling. Systemd dash expansion supplies the actual hierarchy. Directory FDs,
anchor scope inode, real PID/start tick and fixed root-peer Engine readback bind
the lower owner; configuration paths, IDs and census counts confer no authority.
No NixOS files, systemd unit files or host configuration are changed.

The intended controller runs outside the worker parent as UID0:brokerGID with
all capabilities dropped, no-new-privileges, host PID/user/cgroup namespaces,
no network, a read-only root and only its declared binds. It reads its own proc
identity rather than requiring access to another UID's root/exe/ns symlinks.
The root-peer Engine must independently attest the same controller CID/PID,
image, namespace configuration, confinement and exact binds.

Its own fixed outside contribution is bounded separately: 256MiB hard RAM,
zero swap, 128 tasks, no CPU quota and the policy CPU set. Current policy checks
join Engine declarations to the same controller PID/start and actual cgroup2
scope limits before and after policy observation. Kernel CPU ranges are compared
as sets. This does not account for website/recovery reserves or establish
aggregate host headroom or parent-once admission.

Only a nonsecret immutable policy-version directory is mounted read-only.
`~/reverie` remains private0700; `worker-pool/policies` is brokerUID:GID0750,
with immutable `<sha256>.json` files0440. Neither broker credentials nor its
private config are mounted. Future API publication must return a separately
checked directory/version inode+hash receipt under the same actual Q operation;
the existing broker-config CAS receipt does not cover this store. Birth policy
and an activated version remain distinct. A persistent controller must support
that typed activation rather than require file edits or restarts.

The new Docker purpose records parent memory.high=max honestly. Its safety
limits are actual memory.max48GiB, swap0, pids8192, work-conserving cpu.max,
raw cpu.weight and configured/effective CPU+memory-node placement. The old
system-pool proof retains its stronger finite-high contract. Before the first
production48GiB leaf, all previous outside workers must be stopped and settled
behind a real retained provider/Gate fence. No initial census substitutes for
that fence. Each eventual leaf also needs same-incarnation physical membership
and its own exact high/max/swap/CPU readback before pane execution.

The ignored owning Docker test currently exercises only unique implicit parent
creation, original container/PID and parent inode observations, CapDropALL/NNP
host namespace visibility and group-readable0440/version-hash custody. It uses
only controlled fixture data and the bound test ELF. It writes no pool limits,
mints no InstalledPool/Q grant and changes no company seats. Ambiguous effects
retain fixture names/CIDs; local metadata close is never a global acknowledgement.

A separate ignored test is being prepared for independently reviewed limit
writes. Its private test owner retains the actual unique fixture parent and
anchor FDs before one-shot configuration, then starts two native sleep-only
leaves with 48GiB hard limits under the one 48GiB parent. It checks raw high/max,
swap, tasks, CPU weight/no quota and configured/effective CPU+memory-node sets,
including a parent readback immediately after each Docker start before any leaf
high write. It never repairs parent drift silently. The real website is observed
read-only outside that hierarchy; no company data is mounted. This fixture does
not mint InstalledWorkerPool, Q authority or a production provider fence. Known
CID cleanup may leave empty implicit runtime slice objects; those are recorded
as residual metadata, not manually removed or described as complete removal.

Controller policy open returns either the validated owner or an owned partial
failure. The failure retains the same opened directory/file, captured controller
and Engine owner, plus its primary cause; it closes nothing automatically on a
constructor refusal. Checked metadata cleanup remains distinct from pool/outer
operation completion. Consumed-close uncertainty is sticky even after other
descriptors close, and default failure destruction retains its actual owner.
Pool close terminally fences its installed stage before any fallible close.

`OpenedPoolMember` is a separate read-only pre-pane metadata owner. It borrows
the actual installed parent, retains the original leaf directory, and checks
the process PID/start, parent membership, scope inode and exact physical
high/max/swap/task/CPU limits before and after parent observation. The selected
employee's high threshold comes from the retained policy; CPU weight and task
expectations are checked data, never permission. A single init PID does not
prove idle code or an approved image. This owner still needs the actual Created,
Engine spec, start and memory-phase joins before pane execution. It performs no
writes and supplies no admission or launch token. Refusal fences its original
owner; checked metadata close never acknowledges worker or pool settlement.
The lower reader preserves version-one policy compatibility: a finite employee
high equal to its hard ceiling remains readable. New desired-policy validation
in the owner API is a separate contract; this observer cannot rewrite existing
policy semantics. Its borrowed parent lifetime also does not supply a movable
shared controller owner or an authenticated controller-to-broker protocol.

The separate service-v2 birth schema adds original broker observations and a
native-program manifest to the unchanged version-one pool policy. Both schemas
remain DATA. V1 still requires its original serve argv and exactly four binds.
V2 requires explicit versioned serve argv and exactly one additional writable
`<instance>/worker-pool/control` bind. This dedicated directory is
brokerUID:brokerGID0770; only the controller's actual socket is0660, root-owned
with that GID. The policy directory remains0750 and read-only. No capabilities,
network, host configuration or private broker configuration bind is added.

`ControllerEndpoint` retains the actual opened directory before binding through
its FD, owns listener/socket inode custody before validation and refuses any
existing endpoint. The original accepted broker is pinned with SO_PEERPIDFD and
checked against the birth PID/start and UID/GID. This explicitly delegates the
trusted bootstrap's original code qualification; CapDropALL root does not claim
to inspect another UID's current executable. There is no generic stream, command
or path getter. A borrowed peer or partial failure keeps its endpoint and policy
serving scope alive; shutdown must settle them before closing the outer owner.

`BrokerBootstrapBinding` retains the same Runtime origin, an actual SELF PIDFD,
native immutable executable observation and original process snapshot. The App
`BrokerControllerBootstrap` also retains the actual InstallingBroker and checks
its loader-selected source against fixed native `broker --config` raw argv.
Only the compile-bound `REVERIE_FIXED_NATIVE_WORKER_BROKER_MANIFEST` may select
the native program; missing packaging refuses before sockets. No current package
provides that selector yet. Its native executable and no-self-exec invariant
must qualify before production delegation. Broker replacement needs registered
bootstrap; ordinary GUI policy activation must not replace this birth identity.

This cut provides neither immutable policy publication nor active-version
activation. A future checked publication receipt is separate from broker config
CAS. It also supplies no host-administration consent or provider-maintenance
owner. Service-v2 births are explicitly refused by the existing v1 component
initializer, before any limit write. There is no privileged Activate/Configure
consumer, native controller executable, broker member join or selected service.
