# Docker live soft-memory revisions

The verified owner may approve a soft-memory default for all current and future employees. This is desired policy, not a claim that a kernel write ran. The fallback unapproved proposal is 48 GiB. An existing operation retains its exact original request, policy, helper tasks, credential, destination and binding. New operations project the approved default and snapshot it through the canonical Company writer when staging that new operation, before its original policy is used. A soft limit above the original hard ceiling is refused; no hard/pool/swap/CPU/PID limit changes implicitly.

The separate private docker-resource-revisions journal sits beside the canonical company file, outside runtime-key custody. Cross-process flock and complete-file fsync/rename/fsync publication precede helper effects. Defaults and operation-scoped histories remain retained; no malformed-file repair, rekey, automatic deletion or private-row rewrite exists. A lost publication finalizer holds that writer. A fresh process can read the complete durable cursor, but cannot repeat an issued effect.

## API

All endpoints require the actual human owner. Worker identity/recovery/office permissions do not authorize policy edits.

- GET /api/company/docker-resources: desired default and employee history, explicitly enforcement not-observed.
- PUT /api/company/docker-resources/default: body {revision, expectedRevision, scope: "all-current-and-future", memoryHighBytes}. The expected revision is the prior owner UUID or null. Desired-only publication performs no Engine effect.
- GET /api/company/employees/:id/docker-resources: fresh fixed kernel observation; no journal write, CREATE or START. Reports actual/desired high and whether the actual original/revision policy is approved. Unadopted matching kernel values remain visible without manufacturing an ACK.
- POST /api/company/employees/:id/docker-resources/apply: body {revision}. Under exact current owner/employee/SID/generation/binding/recipe/row and original Docker configuration, adopt matching facts without helper writes, or issue one separately journaled fixed Rust configure-memory-high helper. Only that leaf is writable.

Success distinguishes observed adoption from applied helper ACK and reports actual effective policy. It never asserts that a historical original helper enforced a later limit. Reads use original ACK as historical binding evidence and current kernel facts as actual enforcement. A private branded proof permits approved high-only changes in existing-provider/view reads, never in begin, provider creation or original resource configuration. Desired-only changes retain the last approved actual policy until a later real attempt changes it.

Any unknown helper for the same physical CID prevents another revision/scope writer. Retained CREATE can be located and fully qualified; START-issued can only be waited/observed, never started again. Actual qualified Exit0/log ACK and same kernel identities must finish it. Matching current values cannot settle an unknown cursor. No blind retry, global prune or host resource socket exists.

## Current scope

This backend exposes explicit per-employee apply/adoption. The initial packet does not yet automatically converge a retained old operation when a future seat comes online; that bounded convergence phase is required before claiming unattended all-employee persistence. A profile GUI should use these APIs rather than the retired host-socket resource API.

## Independent writer capability

The existing helperImageId remains the original box/anchor/pool/probe/baseline-ACK image. An optional, independently qualified memoryHighHelperImageId selects the new high-only writer. It never participates in the box ID (which remains runtime instance ID plus deployment), never changes the runtime key, and cannot replace an old anchor or ACK image. The write image must support the fixed configure-memory-high program and advertise the deny-only v1 capability; labels are not a substitute for the operator-qualified immutable image pin.

Absent/unsupported writer capability refuses a high WRITE before a writer cursor/CREATE. Existing qualified helper908 still supports read-only actual48 observation/adoption. New writer selection or revision scope changes during an awaited effect revoke that attempt; no fallback reuses old configure-high, which also writes CPU weight. The new mode must write only memory.high, assert all other original limits, and earn fresh readback. Image/native qualification remains a separate deployment admission; source tests do not claim a new image was built.
