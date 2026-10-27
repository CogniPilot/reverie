# Module-managed lease acceptance

The module runs the bounded host lease gate before phase-3 selftest and guarded
observation. This source does not install, activate, start laptops, prune, enable
a timer or grant live-cleanup permission. Tests are not actual host qualification.

The optional broker `leaseAcceptance` object contains exactly `socket`,
`employeeId`, `leaseSubdirectory`, and `peerBinary`. Absence disables this
capability. The socket has its own private broker-owned directory under broker
state, outside employee storage and every configured/inspected worker grant.
A stale socket or unconfirmed cleanup is never adopted automatically. Ordinary
laptop service remains available if this separate capability cannot start.

Its listener unconditionally requires OS UID 0 through `SO_PEERCRED`. The normal
terminal/control socket does not gain root callers. Fixed closed-schema methods
are prepare, during, after and retireOwn. Prepare carries the configured employee
UUID, attempt UUID, 256-bit nonce and an expiry within 90..600 seconds. Requests
cannot select a SID, executable, path, source, image, PID, mount or duration.
There is no TCP endpoint or root/engine socket grant inside a laptop.

The current canonical employee must have a positive persisted integer
`sessionGeneration`; absence, boolean, zero or `bindingMigration` presence refuses.
The selected SID, actual running container ID/image/PID, exact home/tmp binds,
UID/GID and generation must agree with independent host evidence. Stopped,
sleeping and vacation choices refuse. No operation wakes, creates, restarts or
attaches a terminal. The auxiliary helper is separately tracked and bounded.

## Immutable peer execution

The peer is a libc-only C executable built with musl, static linking and no PIE.
It has no Python, dynamic loader or private Nix-store dependency. Production
accepts no command-line path arguments. It sets `PR_SET_DUMPABLE=0` before reading
its controller protocol so the laptop UID cannot trace the proof process or
open its private controller descriptors. The source handles only fixed framed
messages, owned probe files, kernel locks, clocks and bounded cleanup.

The module package exposes `peerArtifactPath`, the root-owned immutable Nix
artifact. Gate configuration and broker configuration must use that exact path.
The gate launcher pins it independently and rejects a config override. The
selected employee's **ordinary lifecycle creation** adds exactly one readonly
single-file bind at `/opt/reverie-acceptance-peer`; other employees retain their
existing mount policy/digest. This grant can use the current approved worker
image. It requires normal reviewed recreation of that peer; no hot mount,
container-root shortcut or forced fleet image change is provided.

Before launch, both broker and host verify native static ELF64 (no INTERP or
DYNAMIC segment), root-owned immutable host bytes, the exact readonly bind source,
readonly/unprivileged container root, and the actual file inode/SHA through its
current PID-root directory. Overlapping `/bin` or `/opt` mounts and other source
aliases refuse. SYS_ADMIN, SYS_PTRACE or ALL capability additions refuse. A peer
without the protected grant is UNKNOWN; there is no fallback to `/bin/python3`.
The fixed exec runs only the declared nonroot user in the existing container ID.

## Actual proof and receipt

The helper holds real SH lease and EX probe locks and a live reservation. Its
new bounded fixtures live under the existing `/tmp` and persistent lease binds.
The host pins all components through nofollow directory descriptors, checks
cross-view device/inode identities, both locks and the reservation, then
exercises the actual installed lease library's root-fchown branch. O_EXCL creation
proves UID 0 before transfer; the retained duplicate lock is explicitly unlocked.

The real persistent barrier stays host EX for **60 seconds**. During that hold,
the helper must remain refused on every SH attempt for **five seconds**, while
opening/taking SH on the same user-owned root-created fixture. After EX release,
it must acquire persistent SH. Host monotonic request/receipt windows anchor
these controls; shared logs and peer wall clocks are not proof channels.

Cleanup unlinks only recorded exact-inode reservation/probe/root-barrier names,
then rmdir removes the fixed empty directories. Unknown contents remain preserved.
Normal lease lock files remain for lease GC. Cleanup or reap uncertainty persists,
blocks new attempts/restart, and cannot become a successful terminal receipt.
No recursive removal or automatic effect retry occurs.

Root attestation independently hashes brokerConfig and checks its current expected worker-config/policy labels, including effective per-session resources and the peer-specific artifact grant. Config/grant drift invalidates a prior receipt even with the same running container. Configured overlaps and actual ancestor mounts (including `/`) refuse before qualification.
Both the broker and root inventory also reject any worker bind exposing the exact
brokerConfig or canonical companyFile, an ancestor, or a resolved alias. Other
company-directory siblings remain eligible for ordinary declared grants. Receipt
code binding includes every packaged host validator, including peer_artifact and
host_install, so validator-only package changes invalidate prior qualification.

The root-private `stateDirectory/lease-acceptance.json` is accepted only with a
matching current ACCEPTED `lease-acceptance-attempt.json`. Starting a new run
invalidates old success through RUNNING; failure records FAILED. The receipt binds
code/config/generation, boot, current canonical registry generation, full running
fleet layout/images/PIDs, persistent lease directory/barrier inodes and mount IDs,
static artifact, attempt/nonce/expiry and real controls. `--check` reopens and
revalidates current bindings and returns the receipt path/SHA; replacement of a
barrier or same-SID generation change invalidates acceptance.

The immutable gate config has exactly version, stateDirectory, deploymentConfig,
peerSocket, brokerUid, peerEmployeeId, peerBinary, peerImageId, generation,
receiptLifetimeSeconds (60..86400), companyFile (canonical private registry), and brokerConfig (the current private broker declaration).
Deployment and identity values remain instance-selected data outside source.

The module unit `reverie-prune-lease-acceptance.service` runs the pinned package
`--run` after declared initialization. Use the actual host namespace (`+` command
prefix or no filesystem namespace), host PID visibility, and a bounded oneshot
with control-group cleanup. Later observation preflight uses `--check` in the
same actual host namespace before janitor sandboxing. Order is initialization ->
real lease acceptance -> confined phase-3 selftest -> guarded dry observation.
The separate selftest receipt is required independently. Existing bootstrap
runtime units require reviewed module/bootstrap migration or normal owner reboot;
no silent overlay or old-state adoption occurs. Real canary/qualification and
independent source review remain required before activation.
