# Reverie application services

`worker_validation::{validate_captured,load_owner_config}` composes the complete
ordered worker validator and its compatible owner-file loader. The returned
snapshot retains original data and readonly observations; no native mount,
start, owner or publication authority is created. Its
[ownership/compatibility audit](src/worker_validation/README.md) inventories the
still-Python runtime consumers and separate startup/effect obligations.

This crate owns workflows across the core, contracts, store and native host
adapters. HTTP/CLI transports should call these services after authenticating
and admitting the operation; they should not reproduce workflow decisions.
The current service is Linux-native because its backing stores and observations
are Linux implementations. Platform-neutral policy remains in the lower crates.

`resource_staging::stage_config` ports the existing profile staging workflow.
It retains the real `profiles.lock` and original profile descriptor through
revision/version/binding checks, resource-map staging, native GPU/perf/memory/
lease projection and all legacy hashes. It checks read finalization on success
and failure and retains both errors if projection and finalization fail. The
borrowed store must also be closed and its result checked by the owner before
any terminal/native operation acknowledgement.

`effective_config` composes the existing GPU, resource, perf, memory and lease
data transformations. Native storage paths come from the same captured worker
configuration. Historical storage can select memory policy but cannot confer a
current employee's GPU/perf grant. Explicit legacy GPU SID priority and inactive
features do not require identity paths or fixed artifact availability. Full
worker schema validation and caller authorization remain outside this service.

Candidates and hashes describe protected configuration data. They grant no
owner permission, native effect permit, start eligibility, reservation or
publication authority. Neither method writes broker configuration, reloads a
worker, invokes an engine or selects a second backend. Production broker
selection and its admission/effect/reconciliation workflow remain migration work.

Tests bind six actual Python profile-stage results to exact candidate/effective
bytes and three separate digests using the real private store. Additional actual
Python native-filesystem vectors cover current GPU/memory and historical memory
without current GPU/perf. Refusal tests exercise stale profiles, custody changes
during resolution, dual failures and inactive/legacy feature bypasses. All
fixtures use owned synthetic files, never company instance data.

`reservation_observer::NativeObserver` owns the complete read-side reservation
observation workflow over one persistent supervised engine client and the fixed
Linux kernel adapter. A captured context binds all censuses and row handles to
the same configuration snapshot. Public contract rows cannot be submitted as
native observation handles. This is an internal broker service, without a wire
constructor, request-selected proc/cgroup roots or arbitrary engine arguments.
The [observation audit](src/reservation_observer/README.md) maps each legacy
method and its remaining effect/admission obligations.

Captured observation contexts retain the same persistent engine/kernel source
and shared cancellation after the installing handle is moved or dropped. Census
data may be compared across contexts using Python structural equality, but row
handles remain bound to their original context and cannot be rebound by equal
data. The owner loader retains its optional source path only after full
validation; embedded captured configurations retain no file binding. The actual
reader and recorded path share Python's lexical `Path` spelling, including
relative and '..' components and the exact double-slash anchor. This is source
data, not configuration custody or a permission grant.

`tests/installed_policy.rs` is a separate, ignored qualification for all four
selected features together: current-employee GPU, the real fixed perf
derivative, memory and the immutable lease peer mount data. Its Python oracle
used the actual existing identity and artifact verifiers without stubs. Only
`worker_perf.__file__` was bound to the installed manifest's sibling location,
matching the existing package convention. The portable fixture substitutes the
owned root, UID and immutable artifact paths; exact output and policy bytes and
both hashes must match. Artifact hashes and the qualified system remain explicit
fixture requirements, so a different build needs its own reviewed oracle.

The test is ignored by the ordinary gate because it requires separately built
real artifacts. Both artifact paths are compile-time bindings; the peer binding
exists only in this test. With `PERF_MANIFEST` and `PEER_BINARY` set to the
qualified immutable outputs and `TMPDIR` set to a short, owned temporary path:

```console
nix develop --command env TMPDIR="$TMPDIR" \
  REVERIE_FIXED_TASK_PERF_MANIFEST="$PERF_MANIFEST" \
  REVERIE_QUALIFICATION_PEER_BINARY="$PEER_BINARY" \
  cargo test --locked -p reverie-application --test installed_policy \
  -- --ignored --exact selected_gpu_perf_memory_and_lease_match_actual_python_bytes_and_hashes
```

This only reads the immutable sources and owned synthetic company metadata.
It never executes the peer, invokes an engine, creates a socket, mounts anything,
changes a profile or qualifies an owner permission or live kernel effect.

`worker_launch` prepares checked request/create/tmux/account data with actual
readonly account/hostname observations. See its [boundary and consumer
inventory](src/worker_launch/README.md); plans are never admission/effect permits.
