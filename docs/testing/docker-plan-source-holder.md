# Read-only Docker plan source holder

This is a private adapter installed by the boxed plan actor. It is not an HTTP
command service, a requester grant, provider health, or paid-launch authority.
The actor supplies its current PlanMoves journal and genuine source reader.

`DockerPlanSourceHolder.open(record, journal, candidate?)` first re-earns actual
source-CID closure and retained HOME identity. It builds a network-none,
unprivileged, read-only helper from the pinned target worker image. HOME and the
optional source-account root are read-only, non-recursive binds. Image volume
declarations are refused; inherited environment keys are cleared, known Node and
loader inputs are cleared, container logs are disabled, and the full image labels
and fixed helper shape are checked.

The one optional `sourceReader` cursor lives in the SAME PlanMoves journal:

| Cursor        | Permitted next work                                                  |
| ------------- | -------------------------------------------------------------------- |
| absent        | Publish original CREATE intent, then one CREATE                      |
| create-issued | Inspect the original exact name; never repeat CREATE                 |
| created       | Confirm actual Created/PID0, publish START intent, then one START    |
| start-issued  | Observe the original running holder; never repeat START              |
| running       | Re-earn exact helper config and PID/birth before/after private reads |
| close-issued  | Observe original terminal/PID0; never repeat STOP                    |
| closed        | Revalidate original terminal metadata; no further reads or effects   |

Each publication uses the exact original cursor. Concurrent opens on one adapter
are refused, and the actual journal CAS also fences separate adapter instances.
Unknown replies retain their cursor. This first slice does not replace an
unconfirmed holder. The holder must be closed before any provider-issued intent.

`context(..., selector)` accepts only a closed provider/native-UUID selector.
It scans bounded actual history for exactly one selected thread. It does not
guess Claude project-directory encoding or select by timestamp. External account
intake exposes only the selected conversation, without account-wide instructions.
Its daemon-side source is derived from actual source-container environment and
mount metadata; the guest root inode must match the held canonical account FD.
No request path is accepted. If that projection is unavailable, the read refuses.

`auth(..., { row, initial })` is restricted to the exact retained-generation
lineage in the target seed. It checks the completed original identity-helper ACK
digest, employee/owner/HOME, historical material and context, and the initial
config-directory inode. SDK auth-file replacement may change fresh auth bytes;
it does not change the historical installed-auth digest. Both are returned only
through the private exec pipe, never argv, journal data or container logs.

The fixed Node program checks real no-new-privileges, zero effective/permitted/
inheritable/ambient capabilities, HOME identity and ownership. Local FD walks
refuse symlinks, unsafe components, writable ancestry and mount crossings.
Private auth files must remain private and singly linked. Files and directory
names are checked around reads, every owned FD is consumed once, and output is
issued only after successful closes. Errors do not include private input/output.
An eight-second monotonic read bound complements the fixed Engine-command bound.

An initially empty generation may later contain genuine SDK-created history.
A fresh selected-thread observation can use that history under the original
config-directory inode. It does not claim historical roles existed at install.

Tests execute the fixed program in owned private directories with actual Linux
FDs and no-new-privileges, including close-ACK loss and file-replacement faults.
Separate injected Engine-port tests exercise publication ordering, restart and
unknown outcomes through the genuine source-reader class. These tests do not
claim Docker image, actual plan replacement, provider dispatch, or office CI
acceptance; those remain the native actor/owned-office acceptance gates.
