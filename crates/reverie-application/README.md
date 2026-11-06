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
