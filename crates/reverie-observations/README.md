# USER observations

`reverie-resource-history` reads explicitly configured USER observations and
prints one bounded JSON projection of them. It replaces
`python/reverie/cleanup/collector_history.py`. Its output bytes match that
program's `json.dumps(..., separators=(',', ':'))`, with the same number types
and key order.

```console
reverie-resource-history --config ~/.config/reverie/observations.json \
  --start 1793836800 --end 1793923200 --resolution hour [--gpu GPU-<uuid>]
```

Custody follows `collector_user.py`:
- The configuration and every observation file must be private, regular,
  singly linked files.
- Every existing ancestor of the configuration and the state directory, starting
  from the owner home, must be an owned directory without group or other write.
- The state directory must be private and carry the observations marker.
- Each read is checked against fstat and lstat stamps.
- After all reads, the configuration, state and directory identity are checked
  again.

Reads are bounded: 8 MiB per file, 32 MiB and 100,000 rows in total, 1024
entries, a 5 s deadline and 2 MiB of output. The address space is capped at
256 MiB. Any refusal prints `Resource history unavailable` and exits 2.

The projection itself is data in `reverie_contracts::resource_history`; this
crate owns the file, clock and deadline effects.

## Collector state

`reverie-collect-state` prepares the collector service's state directory and
replaces `python/reverie/cleanup/collector_state.py`. The collect service runs
it as root before the collector starts:

```console
reverie-collect-state --state-dir /var/lib/reverie-collect
```

- The path must be absolute, without `..` or control characters, and not a
  shared system directory such as `/var/lib` or `/nix/store`.
- Missing directories are created with mode 0700. The path and every ancestor
  must be root-owned real directories without group or other write; existing
  directories are never chmodded or chowned.
- An empty directory gets the custody marker. A directory with any other
  content and no marker is refused, and an existing marker must be a private,
  singly linked root file with the exact marker bytes.

It prints `{"state": ..., "status": "COLLECTOR_STATE_READY"}`, or
`reverie-collect-state: <reason>` on stdout with exit status 2.
