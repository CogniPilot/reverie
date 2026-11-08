# Lease directory command

`reverie-lease` is the native command of `python/reverie/cleanup/lease.py`. It
runs over `reverie_host::lease` and keeps the same contract (r10): liveness is
only a kernel lock or a reservation window, never a PID, heartbeat or metadata.

```console
reverie-lease run DIR [DIR...] -- CMD...   # hold for the command's life
reverie-lease hold DIR                     # until SIGTERM/SIGINT; prints LEASED <key>
reverie-lease reserve DIR --for 6h [--compute-lease-id ID]
reverie-lease renew DIR --for 1d
reverie-lease unreserve DIR
reverie-lease check DIR [--root ANCESTOR]  # {"path", "state", "why"}
reverie-lease gc
reverie-lease ls
```

Holders use the first `--leases-dir`, else `$REVERIE_LEASE_DIR`, else
`~/.local/state/reverie/leases`, and create it. `check` checks every
`--leases-dir` given and never creates one, so a missing directory is unknown.

**Exit codes:**
- `run` returns the command's code; a signal exits as Python's `SystemExit(-N)` low byte;
- `check` returns 0 free, 1 in use, 2 unknown;
- a busy barrier or a removed or replaced directory is 3;
- other lease errors are 2, printed as `lease: <message>`;
- argument errors are 2.

**`run`:**
- starts the command as the leader of a new session, through the reviewed `native::spawn_new_session`;
- forwards SIGTERM, SIGINT and SIGHUP to its group;
- after the command exits, ends the session (SIGTERM, 10 s, then SIGKILL, 5 s) and releases.

**`hold`** prints `LEASED <key>` and holds until SIGTERM or SIGINT.

Both mask their signals before acquiring. A signal that arrives during acquisition is therefore delivered later, where Python could die with the lease half acquired.

The `check`, `gc` and `reserve` output bytes are Python's `json.dumps`.

**Differences from Python, all diagnostic:**
- **`ls`:** keeps the same structure, but uses serde's one-space pretty printer. Holder records are re-encoded with sorted keys and raw UTF-8, and records that serde cannot parse (NaN, for example) are omitted.
- **Argument parsing:** clap's usage text replaces argparse's. `run` takes `DIR... -- CMD...` as two clap positionals.
- **`--wait inf` / `nan`:** wait without a deadline, as Python's float arithmetic does.
