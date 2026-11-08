# Prune r12 data contracts

This first native slice owns TOML config decoding, AUTH-1 root/mount admission
comparisons, stable skip-reason ordering and exit-code data. There is no runner,
filesystem reader/walker, registry reader, lease operation, subprocess, deletion,
package switch or production consumer. The shipped Python packages are unchanged.

`Config` fields are private. Decode rejects unknown fields and wrong types.
`RootObservation` and `MountObservation` are supplied data, not trusted facts.
An anchor is returned only after all selected roots compare successfully; it is
still data, not an effect permit. Unknown observations refuse. Mount selection
uses the innermost containing mount, last-listed among equal mountpoints.
`b_mount` must itself be the approved full-filesystem mount even if an operator
identity and observation both name the same subtree. Checkouts are selected only
by the Checkouts/All passes. Per-candidate anchor comparisons preserve device and
inode identity and reject symlinks and unknown canonical paths.

The next native adapter must collect those observations with native custody,
parse mountinfo, canonicalize/rebase and confine **all** test paths (including
CLI log/summary overrides), and recheck identity at use. Decoding retains raw
path spellings; accepting test context alone does not perform containment.
Registry AUTH-2, trusted-directory chains, registry snapshots, walk/mount-id
preservation, process/lease eligibility and deletion remain separate slices.
A successful AUTH-1 comparison does not approve any of them.

R12 defaults and reason order are retained. The checked-in synthetic fixture
uses the actual unchanged Python r12 `admit_roots` with supplied native facts;
it covers 20 admission cases. This is not a native filesystem/oracle-runner or
live-delete qualification.

## Explicit compatibility differences

- `lease_lib` remains a string but is inert, including empty, nonexistent or
  untrusted path spellings. It is never opened, imported, statted or selected.
  Non-string values refuse. Native lease ownership will be composed separately.
- Production live mode is unavailable even when `live_enabled = true`.
  Test-root live is mode data only; this slice cannot execute it. Test switches
  refuse outside explicit test context at decode and again at admission/mode.
- Invalid scalar types, negative counts/durations, nonfinite durations,
  malformed manifest names, NULs in operational paths, unknown root-identity
  keys, ambiguous root observations and noncanonical root spellings refuse
  explicitly. The old Python loader left some of these unchecked until use.
  Time/watermark values use finite f64; byte/depth counters use u64.
- A future r8 package switch will adopt stricter r12 admission, as approved in
  the design ruling. This PR does not switch packages or remove pinned Python
  payloads. The native production-live identity chain remains P-1b.
