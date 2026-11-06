# Reverie application services

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
