# Disk cleanup: dry-run host installation

The `prune` package contains reviewed prune r8 and lease r7. Its public prune
wrapper always supplies `--dry-run`; combining it with `--live` is refused.
There is no automatic installation, deletion, Nix garbage collection, laptop
restart or change to a personal NixOS repository.

Production live cleanup is **not qualified**. Root/filesystem identity admission,
owner-approved registry provenance, real host/laptop lease visibility, same-device
bind preservation and phase-3 acceptance remain separate gates. Dry-run reports
are observations, not permission to delete their candidates.

## Prepare without changing the host

Build from the project flake:

```sh
nix build .#prune .#pruneHost
```

Write a private deployment JSON outside the repository. All paths must be
absolute and canonical, without symlink components. Replace the placeholders:

```json
{
  "version": 1,
  "deployment": "reverie",
  "b_mount": "/ABSOLUTE-DISPOSABLE-FILESYSTEM-MOUNT",
  "laptops_root": "laptops/employees",
  "laptop_home_root": "/ABSOLUTE-PERSISTENT-STATE/workers/employees",
  "employee_ids": ["REPLACE-WITH-REVIEWED-EMPLOYEE-UUID"],
  "laptop_uid": 1000,
  "laptop_gid": 1000,
  "checkout_roots": [],
  "live_enabled": false,
  "cadence": "hourly"
}
```

`laptops_root` is relative to the actual disposable mount. An employee's host
`/tmp` is `b_mount/laptops_root/<employeeUUID>/tmp`; its persistent home is
`laptop_home_root/<employeeUUID>/home`. Derive IDs and UID/GID from the selected
deployment, not display names or current terminal session IDs. A separate disk's
mount must be present; a missing mount is refused. These checks do not replace
production filesystem identity approval.

Optional keys are `lease_subdir` (default `.local/state/reverie/leases`, relative
to each home), `docker_socket` (default `/run/docker.sock`), `high_water_pct`
(default 70), `low_water_pct` (50), and `cadence` (`hourly`, `daily`,
`half-hourly`). Arbitrary `laptops_cmd`, imported library paths, unknown keys and
live-enabled configurations are refused. The inventory helper uses fixed Docker
metadata-read commands and verifies employee home/tmp bindings, session labels,
UID/GID and visible host init PIDs. Engine errors never become an empty fleet.

Pre-create every employee's persistent lease directory as that employee's user,
mode 0700. Nothing is created inside employee homes by this installer. Missing
lease directories make installation fail closed.

```sh
nix run .#prune-host -- --config /absolute/private/deployment.json \
  --state-dir /var/lib/reverie-prune > /absolute/private/prune-install-plan.json
```

Preparation reads source/configuration and directory metadata only. It does not
create state, contact the engine, install units or start anything. Review its
paths, employee inventory, source hashes, rendered-unit hashes and
`plan_sha256`. Keep the deployment JSON and plan private.

## Owner root activation

The installer needs ordinary host administrator authentication. Container root
and an engine socket are not substitutes. Activate the exact reviewed Nix
launcher and exact plan digest; do not execute an agent-writable installer as root.

```sh
sudo /nix/store/REVIEWED-prune-host/bin/reverie-prune-host \
  --config /absolute/private/deployment.json \
  --state-dir /var/lib/reverie-prune --apply --expect-plan REVIEWED_PLAN_SHA256
```

This installs **inactive** `reverie-prune.service` and `reverie-prune.timer` under
`/run/systemd/system`, with private root reports below the selected state root.
These runtime units **disappear on reboot**; this is observation preparation,
not a completed persistent cleanup service. This works on NixOS without writing
its generated, potentially read-only `/etc/systemd/system` tree or changing a
personal NixOS repository. It never starts either unit. `--enable-timer` only
creates runtime linkage, without starting it. Existing running or transitioning
cleanup units/timers are refused rather than stopped automatically.

The state root and every ancestor must be root-owned, non-symlinked and not
writable by group/others. Reviewed source copies are hash-verified after copying.
In particular, lease.py is materialized below this root so the prune's strict
import checks pass even on Nix systems whose `/nix/store` parent is mode 1775.
The configuration, registry and inventory command are generated under root
custody. The timer cannot supply alternate arguments or choose live mode.
A durable Nix GC root retains the launcher and its dependency closure. Earlier
pins are retained during reviewed upgrades; this tool does not run GC.

## Accept the actual host run

Before starting any lease-aware janitor, prove the selected laptop image/mount
layout shares lease and disposable-directory inodes and kernel locks with the
host, including barrier contention and reservation visibility. Source tests
cannot establish this. A sandboxed phase-3 test is separate operator work;
this installer never runs `--test-root` or a synthetic live deletion.

Once that gate passes, the owner can explicitly run one dry observation:

```sh
sudo systemctl start reverie-prune.service
sudo systemctl status reverie-prune.service
sudo journalctl -u reverie-prune.service --no-pager
```

Inspect private `logs/*.jsonl` and `logs/*.summary.json`: mode must be `dry`,
there must be no `DELETED` or `PARTIAL` deletion decisions, and errors, unknown
leases or skipped inventory require investigation. No candidate bytes were
reclaimed. A successful process exit with everything skipped is not acceptance.

Only after the manual smoke result and chosen observation cadence are accepted:

```sh
sudo systemctl enable --runtime --now reverie-prune.timer
```

This schedules dry-run observations until reboot only. Re-prepare and explicitly
install the reviewed units after a reboot. Durable service integration remains a
separate follow-up in Reverie's portable service installation; it must preserve
these root bindings and acceptance gates. Publishing bounded metadata to a
status page or chat is a separate unprivileged step; the host service carries
no owner login or chat credential. Production live enablement requires a reviewed
successor and its explicit acceptance, not another flag on this installer.
