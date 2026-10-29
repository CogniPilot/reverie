# Optional per-task Linux perf policy

The default broker policy does not open `perf_event_open`. An owner may select
`employeePerfPolicies: {"<stable employee UUID>": "task-v1"}` in private broker
configuration. Empty or absent maps preserve existing launch arguments and
labels. This is a syscall permission, not a launch, owner role, provider action
or execution permission. Current EID/owner/SID/generation must resolve through
the canonical host registry; retired SIDs receive no permission. OFF and vacation
start gates remain in force.

The fixed `workerTaskPerfPolicy` Nix output derives from the same pinned Docker
seccomp profile as the normal rootless policy. It appends exactly one allowance:
`perf_event_open` with syscall argument 2 (`cpu`, a signed 32-bit integer) masked
by `0xffffffff` and equal to `0xffffffff`. Both native sign extension and compat
zero extension represent `cpu=-1`; every nonnegative CPU is denied. The supported
host systems are x86_64 Linux and aarch64 Linux, including their kernel-supported
compat ABIs. No arbitrary profile path or rule is accepted. The broker package
embeds its fixed artifact manifest and verifies both complete files and the exact
one-rule derivative. A source checkout without that installed manifest refuses
selected launches; it does not search environment variables or caller paths.

Every existing rootless Docker guard remains: CapDrop ALL with only the existing
SETUID/SETGID additions, immutable identity helpers, private namespaces, read-only
root, approved mounts, subordinate-ID checks and default syscall denials. No
CAP_PERFMON, SYS_ADMIN, SYS_PTRACE, seccomp-unconfined or host sysctl change is
introduced. Host permission, LSM, task credentials and `perf_event_paranoid`
still apply. `cpu=-1` selects a task rather than a CPU-wide measurement; it does
not grant access to other credentials or another PID namespace. At paranoid=1,
this is **not strictly user-space-only**: seccomp cannot inspect the pointed-to
`perf_event_attr`, and kernel per-task permissions can allow kernel events.
Tools should request user-space events (for example `task-clock:u`); their request
is still checked by the kernel. Profiling itself has not been run as part of
source qualification.

## Installation and activation boundaries

For a new installation the explicit owner map must be present before the
canonical reservation domain is provisioned, and the matching broker artifact
and normal rootless base profile must be selected. Ordinary creation then uses
the fixed derivative only for that employee. Other employees keep byte-identical
launch policies. An old running container cannot acquire a new seccomp filter
in place: a legitimate saved-recipe stop/settlement/recreation is required.

The map deliberately remains part of the canonical reservation-domain digest.
Ordinary resource reload rejects changing it. Existing domain markers, operation
journals and profiles must never be deleted, reset, reprovisioned or silently
rehashed to enable perf. Existing deployments use the separately authenticated host-owner CLI below,
which performs a preserving cold configuration/domain CAS under real admission.
No current employee selection or instance data is included here.

## Host-owner queue, preview and explicit cold apply

Install/qualify the matching broker generation, fixed profile manifest and
`worker-task-perf` CLI first. Source presence or a new console does not make an
older broker understand these verbs. The existing registered service, immutable
Python graph, actual broker/socket birth, unit/environment/GC root and actual host
UID/root/namespaces must all match. A website/OfficeAPI employee, HTTP owner cookie,
JSON role, GPU request or organizational title supplies no authority here. The
OfficeAPI class and GPU approval paths are unchanged. GUI/delegated OPS activation
is not exposed by this slice.

Use the same qualified project source/package for each command; replace the
placeholders only with the selected employee UUID and canonical private config:

```sh
nix run .#worker-task-perf -- --config /owner/private/broker.json --employee EMPLOYEE_UUID status
nix run .#worker-task-perf -- --config /owner/private/broker.json --employee EMPLOYEE_UUID request --enable
# While running, this only queues intent; it never restarts or changes the seat.
# After an independently authorized normal stop and actual settlement:
nix run .#worker-task-perf -- --config /owner/private/broker.json --employee EMPLOYEE_UUID preview
nix run .#worker-task-perf -- --config /owner/private/broker.json --employee EMPLOYEE_UUID apply --plan-digest sha256:REVIEWED_PREVIEW_DIGEST
```

Preview is read-only. Apply requires that exact fresh preview, current
EID/owner/SID/generation, whole company/account/recipe/intent bytes, complete native
inventory, selected stopped CID state, fixed kernel boot/paranoid eligibility,
peer policies/caps/roots, existing profiles and operation history. Changed
previews refuse; the tool never retries automatically. `request --disable` uses
the same separate cold preview/apply path to revoke the permission.

Pending requests keep the old configuration/filter. Apply changes only the
selected employee's map entry and the existing domain marker's configuration
Digest, retaining the original marker bytes/identity in attempt evidence and preserving
all other marker fields, canonical stores and prior receipts. It retains before/after evidence and an exclusive revision
attempt. It stages both replacements before final native/static comparisons;
failed publication/finalizers leave the existing global pending fence, retained
attempt and temporary evidence. Neither cold startup nor an ordinary lookup can
reconcile that state. Unknown history, active resource operations, installed
human-terminal/raw-config consumers or resource actors refuse this transition;
their coordinated migration remains a separate requirement. No history is reset
or rehashed into a new domain.

Success reports `CONFIGURED_COLD_RECREATE_REQUIRED`, with `nativeStarted=false`
and `perfTested=false`. It does not recreate the employee or change ON/vacation.
A later legitimate normal saved-recipe launch recreates with the new fixed
filter, preserving the selected conversation/account/home/Nix/resources through
the existing lifecycle. A surviving old container's label/filter is not reported
as the new active policy; running active status remains unconfirmed by this CLI.
Only a separately authorized bounded native acceptance test establishes actual
perf success. No live activation or profiling run is part of source tests.

References: [Linux perf permissions](https://docs.kernel.org/admin-guide/perf-security.html),
[`perf_event_open` pid/cpu semantics](https://man7.org/linux/man-pages/man2/perf_event_open.2.html),
and the [pinned Moby seccomp source](https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json).
