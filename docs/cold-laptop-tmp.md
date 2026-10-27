# Cold laptop temporary storage

This optional broker policy clears only a canonical employee's owned `tmp`
directory. It does not perform periodic pruning, clean a shared workspace,
change a grant, wake an employee or provide an administrator capability. Absence
preserves the earlier behavior and is not acceptance of cold cleanup.

The owner can select this closed private broker setting:

```json
{
  "coldTemporaryCleanup": {
    "version": 1,
    "enabled": true,
    "hostLeaseDirectories": []
  }
}
```

The array is the owner's explicit inventory of applicable host task-lease
directories. An empty array declares that no additional host lease directory
applies; it is not discovery. The employee's own
`home/.local/state/reverie/leases` is always included. Missing, aliased,
nonprivate, duplicate or malformed lease evidence refuses. Host lease directories
must remain outside laptop state, scratch and declared shared grants. Only a
newly created home gets its initial lease directory provisioned; an existing
missing directory is never silently treated as an empty lease inventory.

The canonical broker holds the employee storage lease, confirms that the prior
named laptop is absent through a complete stable engine census, and refuses any
running, paused or restarting container bind that can read or write this tmp
through a path or inode alias. Bounded kernel mount tables compare filesystem
roots for nested host aliases and actual container-private mount subtrees, even
under a broader source grant. Engine PID/grant snapshots bracket those reads.
Unknown relevant namespace metadata refuses; no global foreign-process observer
or privileged daemon is added. The existing stop/removal path runs first. The
cold cleanup call is inside the `not reuse` branch, before creating/starting the
new container. Reconnection, `attachOnly`, a website restart and adoption of a
running laptop do not call it.

The helper keeps the private tmp directory and its inode, clears its accepted
contents and verifies that it remains writable mode 0700. It opens directories
through no-follow descriptors, checks entry identities and mount IDs, and never
follows a symlink out of the tree. Hardlinks, nested mounts including same-device
binds, foreign ownership, special files such as sockets/FIFOs, preservation/task/source markers
(`.keep`, `.reverie-task.json`, `.git`, `.hg`, `.svn`), live
leases/reservations and unknown evidence refuse before deletion. The canonical
lease janitor holds all configured barriers during the transaction. Its optional
entry/deadline bounds only add refusals; default periodic-prune behavior is
unchanged.

Same-UID process credentials, descriptors, mappings, cwd, root and executable
references are checked. A non-dumpable same-UID process is identified by kernel
UID metadata, not by the owner of its `/proc` directory. Unknown owned-process
metadata refuses. Other unprivileged UIDs are outside the owned mode-0700
boundary; host root/operator access remains the existing trusted engine boundary.
No claim is made about visibility of root-owned file descriptors. This is the
cooperating launcher/lease contract, not protection against a hostile host owner.

A bounded preflight covers at most 4,096 entries and two GiB of metadata-declared
sizes. A shared ten-second budget brackets operations; it cannot interrupt a
blocked kernel syscall. Tmp contents are not read to classify them as disposable.
Unique work must already have a durable home or a preservation marker/active
lease, as required by the storage contract.

Before the first deletion, an exclusive durable
`cold-tmp-cleanup.pending.json` is written outside laptop mounts. The bounded
namespace proof also excludes its private control root from configured grants
and current writable mount aliases. Any partial or
unknown outcome retains it and blocks later launches even if cleanup is disabled
or the session changes. Success writes a separate completion receipt, verifies
tmp custody, then completes every flush and lease/descriptor finalizer while pending remains.
Fence unlink is the final fallible operation, after the durable completion; no
flush or resource finalizer follows it. Its removal need not survive a crash: a
fence may conservatively reappear, while completion remains durable. There is no
automatic replay or repair verb.

The portable `workerBroker` package references the filtered immutable source
closure, which includes `worker.py`, `worker_cold_tmp.py`, `worker_tmp.py` and the
canonical `cleanup/lease.py`. Both the user-service package and the optional
isolation module execute that same broker package; neither copies a separate
module list. Ordinary user-service installation needs no personal NixOS change.
The optional NixOS service retains its declared writable-path restrictions;
lease directories must be writable within that independently selected sandbox.
No host service or policy is activated by this source change.

Before enabling this policy, validate actual cold starts and reconnections,
active-process and lease protections, migration preservation, and the selected
read-only recovery archive. Verify kernel write refusal and unchanged archive
bytes. Synthetic fixtures and packaged-import checks do not establish these
production guarantees. Periodic pruning requires separate validation.
