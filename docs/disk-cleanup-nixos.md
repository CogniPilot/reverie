# Declared NixOS dry-run cleanup

The tracked `nixosModules.reveriePrune` module supplies reboot-persistent cleanup
units. Both the service option and timer scheduling default off. The module
uses the separate prune r12 candidate/lease r7 dry-run packages and an r12-pinned
initializer. The portable bootstrap retains its original r8 pins. Neither path
qualifies live deletion, migrates an existing installation or activates a host
itself.

Import the module from the owner-selected Reverie flake revision into the host's
ordinary NixOS configuration. No personal NixOS repository is part of Reverie.
Set the nonsecret deployment bindings explicitly; replace every example path and
employee UUID below with reviewed host values:

```nix
{
  imports = [ reverie.nixosModules.reveriePrune ];
  services.reverie.prune = {
    enable = true;
    # Leave scheduling off until host/lease checks and a manual dry run pass.
    timer.enable = false;
    stateDirectory = "/var/lib/reverie-prune-declared";
    cadence = "hourly";
    deployment = {
      name = "example";
      disposableMount = "/DISPOSABLE-MOUNT";
      laptopsRoot = "laptops/employees";
      laptopHomeRoot = "/DURABLE-EMPLOYEE-ROOT";
      employeeIds = [ "11111111-1111-4111-8111-111111111111" ];
      laptopUid = 1000;
      laptopGid = 1000;
      checkoutRoots = [ ];
    };
  };
}
```

These values become a Nix store configuration and must contain no secrets.
Identity histories, credentials and memories stay outside the module and source
repository. Optional deployment settings are `leaseSubdirectory` (default
`.local/state/reverie/leases`), `dockerSocket` (`/run/docker.sock`),
`highWaterPercent` (70) and `lowWaterPercent` (50). Cadence accepts `hourly`,
`daily` or `half-hourly`. There is no arbitrary command or live-mode option.

Use ordinary owner NixOS evaluation, review and activation. Merely enabling the
service option declares its oneshot and timer; it does not start an observation
or schedule it. With `timer.enable = true`, ordinary activation and later boots
start the declared timer. Its `Persistent=false` setting disables catch-up for
missed observations; the declared unit definitions still survive reboot.

Before the first observation, pre-create every reviewed employee's persistent
lease directory as that laptop user, mode 0700. The root helper never creates
directories in employee homes. The disposable mount, home paths, canonical IDs,
UID/GID and fixed Docker metadata inventory must pass runtime checks. Missing
leases, unreadable inputs, protocol failures and unexpected bindings fail closed.

The first run materializes hash-verified source copies and generated
configuration in pristine, root-owned state. Every ancestor must be root-owned,
non-symlinked and not writable by group or others. Copying the lease source here
preserves its strict import checks on Nix installations with a mode-1775 store.
Later runs verify the exact immutable package/configuration binding without
rewriting it. System generations retain the Nix closure. No separate GC action,
owner login or chat credential is used by the root service.

The r12 declaration initializer and its fixed inventory command use the same
immutable launcher. Its source pins are independent of the r8 bootstrap; command
arguments cannot select another revision. Package hash verification and module
evaluation bind the declared janitor and initializer to the exact candidate
source. These bindings do not establish filesystem identity admission or any
other host acceptance gate; a source gap remains a failed acceptance gate.

The fixed initializer runs as host root before the janitor enters its filesystem
sandbox. Its systemd `+` command prefix preserves the actual host mount view:
sandbox-created bind mounts must not satisfy admission of the disposable disk.
The initializer validates custody before creating absent state; there is no
tmpfiles ownership change of an existing directory. The janitor itself retains
the read-only filesystem sandbox and explicit writable lease/report paths.
See the [systemd command-prefix documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Command%20lines).

The module uses the same unit names as the [portable bootstrap](disk-cleanup.md).
Existing `/run/systemd/system/reverie-prune.*` units or runtime drop-ins cause
refusal, including inactive bootstrap units. Transition through an owner-reviewed
migration or reboot that clears the runtime installation; do not overlay it or
assume a successful host switch accepted the service. The bootstrap installer
also refuses to shadow loaded declared units. The module does not stop an active
oneshot during a configuration change.

Existing bootstrap state, partial initialization and changed configuration or
package bindings are never adopted or upgraded. For an upgrade, the owner first
disables scheduling and confirms cleanup is inactive, then reviews and declares
a fresh dedicated state directory with the new revision. Preserve earlier
reports and registries as private evidence. A future state migration needs its
own reviewed protocol; copying old files into fresh state is not supported.

Complete the actual host/laptop inode and kernel-lock acceptance described in
[the cleanup guide](disk-cleanup.md#accept-the-actual-host-run), then explicitly
start one `reverie-prune.service` observation as the host owner. Inspect private
reports for dry mode and investigate all inventory errors, unknown leases and
skips. After acceptance, set `timer.enable = true` and activate through the normal
owner process. This module never grants production live-cleanup authority.

Root cleanup runs with host administrator authority. The user worker broker and
image builder retain their user authority; neither can activate this module,
replace its root-controlled code or turn container root into host root.

This is durable integration for NixOS hosts. Portable bootstrap remains a
separate runtime-only installation path, and broader fresh-download portable
service installation remains unfinished. No NixOS activation, actual host run or
live-cleanup acceptance is implied by source tests or module evaluation.
