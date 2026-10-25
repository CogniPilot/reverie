# Declared synthetic cleanup acceptance

The phase-3 module packages the reviewed selftest r2 bytes, SHA256SUMS prefix
`50a2e393`: selftest `280dd66b`, kit `cf4ca5a1`, suite `b94a3959`, runner
`5e5f776f`. The package verifies all four complete hashes. The r12 prune and r7
lease hashes are separately pinned. This integration is source for review;
no host test or activation has been performed by this change.

The module extends `services.reverie.prune.selftest`. `enable` defaults false.
An owner must explicitly select unused, positive numeric `uid` and `gid`, distinct
from the real laptop user/group. Ordinary NixOS activation declares the dedicated
`reverie-prune-selftest` system user/group; no account is changed by evaluation.
`fixtureName` defaults `.reverie-prune-selftest`, immediately below the disposable
filesystem mount. It must remain outside the real `laptopsRoot`.
`stateDirectory` defaults `/var/lib/reverie-prune-selftest`, separate from both the
disposable filesystem and production cleanup state.
Paths beneath `/home`, `/root` or `/run/user` are unsupported because the required
home protection hides them; the module rejects them rather than weakening it.

A fixed preparation service validates the actual host mount and protected
directory ancestry. It refuses foreign, partial or changed state rather than
adopting, chowning or clearing it. It copies the exact lease library into the
protected receipt state and verifies its hash, avoiding the strict import
rejection caused by mode-1775 Nix store parents. No tmpfiles rule touches these
paths. The setup service never runs a test, engine command or unit-control verb.

The test service uses private mount, temporary and network namespaces. Its
filesystem is read-only except the dedicated synthetic base and receipt state;
systemd also supplies a private temporary filesystem and a root-only transient
runtime directory for the runner configuration. Host PID visibility is retained:
the kit creates its own nested PID namespace, and the janitor must inspect it.
No namespace/capability restriction has been added that would disable this test.
`KillMode=control-group` retires remaining processes at unit completion.

Acceptance order is declared initializer, real-laptop lease acceptance, synthetic
phase 3, then guarded observation. The phase-3 service requires
`reverie-prune-lease-acceptance.service`; an absent predecessor fails the unit.
The separate real-laptop gate owns PeerPort and H1-H4 lease visibility, contention
and post-release checks. This kit covers 13 synthetic results: checkout, control,
cwd, exe, fsmonitor_not_run, host_result, leased, mmap, mount,
no_proc_unreadable, openfile, reserved and victim_intact. Neither gate alone grants
live cleanup authority. There is no timer or automatic selftest start here;
the reviewed acceptance workflow must request these declared units.

The selftest writes `stateDirectory/selftest-receipt.json` atomically, mode 0600.
Live enablement must independently require PASS, every exact named result, the
expected code hashes, current binding and the declared receipt's SHA-256. Keeping
this receipt outside fresh production state permits the guarded initializer to
copy the approved evidence without depending on its own not-yet-created state.

The reviewed kit's report records r2 rehearsal PASS for r12 (13/13) and a
discriminating r10 bind-mount FAIL, using unprivileged user/mount/PID namespaces
on an agent laptop. Those are
attributed rehearsal results, not acceptance of the actual systemd sandbox or
host. R2 adds exact result names, bounded nonblocking nofollow reads with ownership
checks, and fail-closed timeout retention. Independent review of r2 and actual
host acceptance remain required before any activation decision. The source r1
review alone does not establish r2 or operational acceptance.

The flake exports the package as `pruneSelftest` and includes these disabled
options in the existing `nixosModules.reveriePrune` module. The
`checks.<system>.pruneSelftestService` check evaluates that actual exported module;
it builds synthetic unit text and never installs accounts, runs either unit, or
performs the kernel selftest. The real lease-acceptance predecessor is not
provided by this export, so this source is not an activation-ready deployment.
