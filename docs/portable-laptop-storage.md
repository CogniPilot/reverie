# Portable laptop storage and resource policy

The default isolated-worker backend is local Linux with a compatible container
engine. Admission mode needs no personal NixOS configuration: every laptop gets
an explicit RAM ceiling, equal memory+swap ceiling (no swap), and task ceiling;
the broker checks actual peer reservations against the owner-sized budget.
CPU remains uncapped unless the owner explicitly selects a CPU cap. A shared
memory pool is optional and must have verified finite protection before use.
Missing protection refuses execution rather than allowing unlimited workers.

The existing owner user-service package is `workerService`; it uses the pinned
`workerBroker`, private configuration and a 512-MiB/512-task broker ceiling.
It does not require a host operating-system repository or rebuild. Normal engine
access does not authorize a privileged container, host socket grant to a laptop
or a host administrator workaround. Actual installation still requires engine
resource capability and effective-limit acceptance. `/proc`/cgroup-based broker
checks mean Docker Desktop or a remote engine is not a supported substitute for
this local Linux backend; native website support on another OS is separate.

## Temporary drive

`/tmp` is a bind of only the current laptop's private `tmp` directory on scratch.
The host creates/validates its canonical, owned, mode-0700 ancestors before
container creation and refuses symlinks, unsafe modes and non-identity paths.
It never mounts the scratch root or another employee's directory at `/tmp`.
`TMPDIR`, `TMP` and `TEMP` are `/tmp`, including tools launched through Hands.
Default build/cache/download locations use `/tmp/reverie/projects/<cwd-hash>/...`
for separation between working directories. Set project-specific paths beneath
`/tmp` when a tool needs another layout.

`/scratch` remains mounted for compatibility with existing paths. This is not
permission to delete it: existing repositories, analysis, results, profiles or
legacy stores must be preserved first. Source, unfinished work and retained
results belong in verified durable repositories/workspaces or private home.
Installed packages, registrations and profile roots belong in private `/nix`
and `/home/agent`. The generated home `AGENTS.md` updates only its marked storage
block and preserves other owner text; ambiguous or aliased files refuse updates.

Canonical storage is selected by the trusted employee-identity resolver, never
a human folder name or a request-supplied path. Its integration supplies the
resolved employee scratch path to `create_args(..., scratch=...)` and
`prepare_temporary`. This independent component retains an explicitly marked
legacy SID caller for composition with the earlier source. **That caller must be
replaced by the canonical resolver before claiming the employee-storage rollout
complete.** Session/transport IDs are not persistent laptop identities.

## Maintenance acceptance

Temporary mounts, stable homes/stores, image/security profiles and admission
ceilings change the realized container shape. Treat store publication and the
separately reviewed laptop upgrade as different acceptance steps. Never weaken
the old migration verifier's exact configuration, peer, mount or resource checks.
Preserve all owner pause/vacation/off intent. A healthy native tool diagnostic is
not permission to start a provider or wake a vacationing employee.

Before cleanup, preserve every non-cache source/result/private-state namespace,
prove copied registrations and profile links, verify exact new mounts/resources
and absence of unreviewed grants, and reconcile uncertain receipts. All jobs using
temporary paths must be stopped. Directory names such as `build`, `tasks`, `tmp`
or `cache` alone are not a safe deletion policy.
