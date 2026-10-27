# Portable installer compatibility successor

This source is a separate compatibility successor to the reviewed r4 installer.
The original r4 release and its evidence remain unchanged. The tarball pinned in
[disk-cleanup-portable.md](disk-cleanup-portable.md) contains r4, not this
successor. A successor release needs its own source review and release hash.
No install, host qualification or acceptance permission is granted here.
Normal application startup has no dependency on this optional host adapter.

Only executable and source-program custody gains the existing immutable Nix
output rule. A program under `/nix/store` must pass `host_install.immutable`:
root-owned store and outputs, protected parent, sticky store if group writable,
and no writable output component. Its existing root-owned leaf-symlink rule is
retained. Distro program paths retain the ordinary strict protected chain.
The bootstrap first verifies the sibling helper's exact pinned bytes, executes
only those verified bytes, then uses that helper to check both store program
paths before returning it. Configuration, data, release-input manifests, state
and unit directories retain their existing custody rules. No user-owned store
or writable-child exception is introduced.
The given executable name used in units is also root-controlled, including the
parent and root-owned leaf of a distro upgrade alias. A user-owned alias to an
otherwise trusted interpreter refuses before it can become a unit launcher.

`--unit-dir` is an explicit closed choice between `/etc/systemd/system` (the
unchanged default) and `/usr/local/lib/systemd/system`. Preparation reads the
fixed system manager's `UnitPath` and requires the selected path to be present.
Every existing selected-directory ancestor must be root-owned, real and not
writable by others. An immutable `/etc` symlink makes the default refuse; it
never triggers automatic fallback. An owner may separately review the explicit
vendor-directory choice. The installer never edits a personal NixOS repository.

The plan binds the chosen directory, complete manager search-path list,
installer SHA and both rendered unit hashes in `unit_source_sha256`. The
root-protected install manifest records the same directory, search list and
source digest. Check/inventory derive the choice only from that manifest and
reject command-line overrides. A legacy manifest without this binding refuses
adoption. Changes require a fresh owner-reviewed plan. Source release files are
never overwritten with different bytes; an already installed r4 release needs
an explicitly reviewed new prefix rather than silent replacement.

Before writing, the installer refuses any cleanup unit or named drop-in in
another manager search directory, as well as explicit runtime units/drop-ins.
It checks manager `FragmentPath` and `DropInPaths`, confirms inactive/dead units
and zero service PIDs, then repeats these checks under its install lock. After
reload it requires loaded units from the chosen directory with no drop-ins and
unchanged manager search paths, then rechecks the installed code, data and source
digest. Failed post-reload verification reports failure
and preserves written state for owner review. There is no automatic rollback,
cleanup or retry. Existing r8 runtime units require a separate reviewed migration.

The `--enable-timer` option remains parseable for compatibility but now refuses
before any effect with an acceptance-required error. No command enables or
starts a unit. Real laptop lease acceptance, confined phase3 acceptance and a
fresh guarded dry report remain separate mandatory workflow gates; this change
does not supply their unit wiring or infer that they passed. Live deletion stays
disabled.

The input configuration continues to use its existing stable regular-file read
and exact owner-reviewed plan SHA. This is intentional binding of the supplied
bytes, not adoption of its directory or a new root-owned-input claim. Installed
configuration and state remain root-protected. Tests use owned fake manager and
filesystem fixtures; the actual host and systemd behavior remain unqualified.
The separate flake release-artifact proposal is unaffected and supplies no
privileged executor or automatic service hook.

## Remaining installation qualification

The compatibility source is available for review. It does not provide an
operationally accepted installer or enable a timer. Real lease/self-test/dry-run
acceptance and release packaging remain separate requirements.

A copied-prefix unit that references Nix-store interpreters or tools also needs
durable GC roots retaining their complete runtime closures. This installer does
not create or verify those roots. A path recorded in a manifest does not retain
it against Nix garbage collection. The future packaged installation must prove
that retention before it can claim durable Nix-host operation. No personal
NixOS configuration change is required or authorized by this source.
