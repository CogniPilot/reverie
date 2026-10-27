# Portable dry-run cleanup installer

This is source for review, separate from normal Reverie startup. The pinned
r4 procedure below records the earlier reviewed release; its tarball is not
published by this checkout and it does not contain the current compatibility
successor. It is not a current installation approval. Read the
[compatibility and qualification notes](disk-cleanup-portable-compat.md),
including Nix runtime-closure retention, before preparing a future owner install.

This path installs the same r12 dry-run cleanup as the NixOS module on any Linux host with systemd and a container
engine. It needs one ordinary owner `sudo` session at install time. After that, observations, checks and inventory run
through the installed units. It never enables live deletion.

## Pinned release

| File | sha256 |
| --- | --- |
| `reverie-prune-r12-portable.tar` | `4ac884623c6f2a501676ea0d83f286ca18f749f234471d6a693a7d5b853c42a0` |

The tarball holds `reverie-prune-r12/{reverie_prune.py, lease.py, host_install.py, portable_install.py, SHA256SUMS}`.
`portable_install.py` pins the prune, lease and installer sources again and refuses any other bytes.

## Install

Verify the tarball before anything runs as root, then extract it into a root-owned directory and run the installer from
there. Never run the installer as root from a directory your user can write to; it refuses to.

```sh
echo '4ac884623c6f2a501676ea0d83f286ca18f749f234471d6a693a7d5b853c42a0  reverie-prune-r12-portable.tar' | sha256sum -c -
sudo install -d -m 0700 -o root -g root /root/reverie-prune-release
sudo tar -x --no-same-owner -C /root/reverie-prune-release -f reverie-prune-r12-portable.tar
R=/root/reverie-prune-release/reverie-prune-r12
sudo /usr/bin/python3 -I -B "$R/portable_install.py" --install-release "$R"
```

That copies the release into `/usr/local/lib/reverie-prune/r12-fbed566fbdfe/`, read-only and root-owned. Write the
owner configuration `/etc/reverie/prune.json` (root:root, 0644, no secrets). It uses the same keys as the NixOS
deployment, plus `root_identities`: each configured root maps to `{source, fstype, mount_root}` from the host's
mountinfo, and the disposable mount must use `mount_root: "/"`.

```sh
I=/usr/local/lib/reverie-prune/r12-fbed566fbdfe/portable_install.py
TOOLS='--python /usr/bin/python3 --docker /usr/bin/docker --systemctl /usr/bin/systemctl'
sudo /usr/bin/python3 -I -B "$I" --config /etc/reverie/prune.json $TOOLS            # prepare: prints plan_sha256, writes nothing
sudo /usr/bin/python3 -I -B "$I" --apply --config /etc/reverie/prune.json $TOOLS --expect-plan <plan_sha256>
```

`--apply` writes `/var/lib/reverie-prune` and `/etc/systemd/system/reverie-prune.{service,timer}` with a managed marker,
reloads systemd and starts nothing. Pre-create each laptop's persistent lease directory first, as that laptop user,
mode 0700.

Acceptance in a container (no Nix) can verify the release, `prepare`, the rendered units (`--render-units DIR` plus
`systemd-analyze verify`) and the installer's own test suite. `--apply` deliberately refuses container root, so the real
install, check and dry run need a systemd host.

## After install

- `systemctl start reverie-prune.service` runs one dry observation. Its `--check` step verifies the release pins, every
  installed file and unit, and the exact configuration.
- OS tools are bound by a root-owned resolved path. A package upgrade that changes their bytes is recorded as
  `binding_changes` in the check output and does not stop the service; a tool that becomes group- or world-writable refuses.
- Enable the timer only after the self-test and a clean dry-run report.
- To upgrade, install a new release into its own prefix entry and re-run prepare and apply; existing files are never
  overwritten. To uninstall, disable the units, remove the two marked unit files and reload systemd. Keep the state
  directory as evidence.
