# Optional per-task Linux perf policy

The shared Nix worker base includes Linux `perf` for ordinary, browser and
rootless worker image factories. Install tools through that image configuration;
do not install packages separately in employee containers. Rebuild and use the
normal preserving recreation workflow to update old images.
The supported Nix `withPython = false` override disables embedded Python and
upstream perf's runtime Python scripts. Upstream's Python build generators remain
third-party build tooling; no first-party Python implementation is added.

On NixOS, `services.reverieWorkers` declares
`boot.kernel.sysctl."kernel.perf_event_paranoid" = lib.mkDefault 2` when
`taskPerf.enable` is true (the default). This permits per-task user-space
measurements; normal host-owner overrides remain effective and can make the
acceptance test fail. No container changes host policy. An optional shared
`allowedCPUs = [ 0 1 2 3 4 5 6 7 ];` assigns processes actually attached to
`reverie-workers.slice` to those CPUs through normal NixOS activation.
Its default is `null`, which inherits placement rather than assuming eight CPUs
on every host. Confirm each seat's actual cgroup parent and effective CPU mask
after activation. An inactive slice or a configured parent string does not prove
attachment; Docker's empty `CpusetCpus` alone proves neither pinning nor its absence.

## Real container acceptance

```sh
nix build .#workerImage --out-link /tmp/reverie-perf-image
nix build .#workerTaskPerfPolicy --out-link /tmp/reverie-perf-policy
docker load --input /tmp/reverie-perf-image
nix develop --command cargo xtask verify-worker-perf --image reverie-worker:latest \
  --policy-manifest /tmp/reverie-perf-policy/share/reverie/worker-perf-profile.json
# Check all currently running laptops in one deployment, without recreation,
# installation, policy changes or host sysctl writes:
nix develop --command cargo xtask verify-worker-perf --deployment DEPLOYMENT
```

The test performs real `perf stat`, `perf record` and `perf report` with positive
`task-clock:u` counts and actual samples from a fixed, short user-space workload.
Recording uses `--per-thread --all-user`: the task-only seccomp policy requires
CPU `-1`, while perf's default recording opens per-CPU buffers. The kernel's
[perf record documentation](https://raw.githubusercontent.com/torvalds/linux/v6.12/tools/perf/Documentation/perf-record.txt)
describes these options. Use them when recording a laptop task; this acceptance
does not grant per-CPU or system-wide profiling.
It uses a nonroot process, no effective/permitted capabilities, active seccomp
and no admin/perfmon/ptrace capabilities in its bounding set. The image fixture
also enforces no-new-privileges, drops all capabilities and uses the
hash-verified generated task-v1 derivative, read-only root and private scratch.
It grants neither CAP_PERFMON nor SYS_ADMIN and uses no privileged/unconfined
fallback. Private profiling files are removed after the test. A missing tool,
denied event, missing kernel support, zero samples or changing inventory fails.
The local mode checks immutable container IDs before/after and checks every
running laptop; zero laptops do not constitute success. Existing old-image or
old-filter failures remain failures until normal preserving recreation.
The local mode preserves the canonical rootless launch policy: its fixed ID
helpers need the existing `systempaths=unconfined` exception and intentionally
omit no-new-privileges. This test does not impose NNP or confuse that exception
with forbidden seccomp/AppArmor-unconfined or privileged operation. The actual
kernel capability/UID/seccomp checks still run before invoking perf.

The image CI job runs `cargo xtask verify-worker-perf --ci`. This Rust task
prepares only its declared disposable Ubuntu GitHub-hosted VM, builds the Nix
worker image and policy, and runs the strict real test. It invokes programs
with explicit arguments, without shell orchestration. The pinned Nix Skopeo
package imports the image under an initially absent temporary tag; the archive's
ordinary worker tag is never imported. Both verification outcomes attempt
cleanup of that temporary tag and the owned archive link/directory. There is no
image pruning or container removal. The task refuses local/self-hosted machines
and nondefault Docker endpoints, and is not part of ordinary verification or
product startup. Nix store outputs remain managed by Nix.

The explicit `--temporary-image` verification purpose attempts removal of the
exact tested immutable worker image ID and unchanged Nix archive out-link after
either verification outcome; it never prunes images or removes containers.
NixOS deployments use the declarative module instead. An image test proves
container compatibility; it does not claim that every existing employee was
migrated or that hardware PMU events are available.

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
