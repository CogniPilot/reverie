# Owner control registry and fence prototype

This library is source for review. It has no CLI, flake hook, default application
startup action, installed adapter or runtime authority. No actual owner registry
has been created by this change. Future integration requires qualified native
providers, owner installation and independent review.

`OwnerControlRegistry(provider)` derives the fixed registry from the OS owner's
account home: `.local/state/reverie/owner-control/v1`. It does not accept a caller
state directory or mutable `HOME` override. `for_fixtures(home, provider)` is only
an owned test injection, not a production registration surface.

The provider's bounded `snapshot()` returns exactly `engineId`,
`primaryStateDirectory`, `configuredBindSources`, `actualBindSources`, and
`workerConfigSha256`, `workerDeployment`, and `workerImage`. Bind sources must include every configured and actual
website and worker grant. Provider completeness, actual engine identity and
readback authority are external qualification requirements; this module cannot
turn caller-supplied facts into runtime proof.

`propose(request)` and `load()` are read-only. The request has `containerName`,
`stateDirectory`, `deploymentPath`, `policyPath`, and
`maintenanceLockDirectory`. The maintenance directory must equal the deployment
parent's `runtime/update-state`. Control directories already exist, are owned
and private; approval inputs are owned single-link regular files mode0400/0600.
The module never creates or adopts those data paths. Only explicit
`register(proposal)` creates its own registry/control metadata during a future
owner-install action. Exact repeat is idempotent; other binding/path changes
refuse until a reviewed migration API exists.

The binding view has exactly seven fields: the five request fields plus
`resourceId` and `generation`. The resource ID binds actual engine ID and the
primary website STATE DIRECTORY device/inode. It does not bind an atomically
replaced JSON file inode. The record additionally binds canonical primary path
and control-directory identities. A same path or physical state directory under
a different engine, a replaced directory, or the same engine/container name
moving to another state refuses migration. Generation is a stable
`sha256:<64hex>` digest of that exact registration, not an authority signature.
Atomic replacement of an input JSON at its unchanged private path does not
change resource identity; callers still bind its bytes in their owner plan.

Every control, approval and registry path must remain outside all supplied bind
sources, including lexical, resolved and physical ancestor aliases. Private
mode0700 alone is insufficient when a container shares the owner's UID. Every
component is opened without following symlinks; records and locks require owned
single-link mode0600 files. Writes fsync the file and parent. Partial registration
and temporary publication evidence is retained and blocks adoption. Storage
failure never returns a clean operation permit.
An existing nonempty namespace with no registry lock refuses without recreation.
Only bounded-empty explicit initialization creates it; an existing lock must stay
empty, regular, owned, mode0600 and single-link at admission and scope exit.

The operation API supports two explicit admissions:

- `begin(operation_id32hex, worker_plan)` recomputes the exact child plan digest,
  requires `worker_service.UNIT`, and matches actual engine, deployment, old image
  and config SHA. It persists `WORKER_IN_FLIGHT` before returning a private handle.
- `begin_unchanged(operation_id32hex, observation)` requires the closed
  `reverie.owner-control.worker-unchanged` version1 object: `engineId`, `unit`,
  `deployment`, `image`, `configSha256`, and `parentPlanDigest`. Actual worker
  facts must match. The REQUIRED qualified provider method
  `admit_unchanged_worker(binding, observation, readback)` must independently
  admit the approved parent plan and actual readback. Its closed result is
  `bindingDigest`, `inputDigest`, `readbackDigest`, `evidenceDigest`, all prefixed
  SHA256. The first three bind the exact arguments with the shared codec. This
  is not a receipt-free skip flag; absent/unqualified providers are unavailable.

The changed path's `operation.worker_committed(receipt)` accepts only the closed
committed child receipt, matching old/new/engine/unit/before SHA and fresh actual
new image, deployment and after SHA. It persists the verified worker readback.
Both paths recheck that exact readback before website effects.

`operation.website_in_flight(intent)` persists a closed version1 intent before
the child is called: `operationId`, `name`, `oldId`, `oldImage`, `newImage`,
`planDigest`, `controlBinding`, `controlGrantDigest`, `specPin`, `schemaFloors`,
`automaticOldImageRollback`, `finalSpecApproval`. It requires the registered
binding, distinct exact IDs/images, approved child plan/spec references,
`schemaFloors=["GOAL","AUTH"]`, `automaticOldImageRollback=false` and
`finalSpecApproval="approved"`. Child operation IDs cannot reuse any prior parent
or child ID. A later child must continue the previous adopted container/image.

`operation.website_adopted(receipt)` requires the exact completed forward-only
WebsiteStage receipt, including its checkpoint digest. It calls the REQUIRED
fresh native `admit_website_adoption(binding, intent, receipt)`. Its closed result
is `bindingDigest`, `intentDigest`, `receiptDigest`, `readbackDigest`,
`evidenceDigest`. The first three bind the exact arguments. The readback digest
binds `{engineId,newId,newImage,newRunning:true,oldId,oldStopped:true,worker,
bindingGeneration}`; `worker` is the verified current `{engineId,unit,deployment,
image,configSha256}`. The qualified provider must actually establish these facts,
current namespace/control custody and forward schema compatibility. Returning a
digest of caller data without inspecting the native state supplies no authority.

ADOPTED is published only after a complete immutable history record is fsynced.
History retains every intent, receipt, checkpoint reference, admission and prior
history digest. It never clears or deletes the forward schema fence. A subsequent
explicit begin is allowed only when the complete history chain is valid, current
fence equals its last ADOPTED record, and fresh native adoption admission confirms
that the actual state still matches. Operation IDs are never reusable.

Capacity is admitted before a child permit. Bounded enumeration consumes at most
4097 entries for the 4096-entry namespace, with at most 1024 registrations and
1024 histories per resource. Under the global registry lock, every durable
nonterminal fence reserves three additional namespace slots: its history record,
a partially written temporary fence, and an uncertainty marker. Concurrent
operations on other resources and registrations must account for those durable
reservations. Registration preflights its new binding plus the first complete
operation path; begin rechecks and reserves before returning. A known full
namespace/history refuses before effects and does not replace an ADOPTED fence.
No automatic history pruning or capacity-migration route is provided.

Every unfinished, partial, malformed, contradictory or unknown operation remains
HELD across reopen. No handle can be reconstructed after a crash. Transition
errors poison the handle; adoption/cleanup uncertainty retains a protected poison
marker when storage permits. Storage failure remains UNCONFIRMED even when the
marker cannot be written. There is no reset, force, clear, resume, retry, rollback
or unknown-state recovery API. Explicit successful operations are repeatable in
owned fixtures; actual installation/runtime acceptance remains unavailable.

The GOAL/AUTH names are persistent review markers, not measured monotonic schema
epochs. A qualified provider/release catalogue must establish actual forward
compatibility. Installed service-to-selected-config provenance, native custody,
parent approval and fresh worker/website readback are still OPEN production
qualification requirements. This source provides no native authority adapter.

Tests use real owned files, real cross-process flock contention, controlled
fsync/cleanup failures and fake provider facts. No Docker, service, root, key,
actual registration, runtime update or host setup action is performed.

`provider.admit_control_custody(binding, control_paths, all_sources)` is also a
REQUIRED native port. The registry exposes the same delegation for the website
stage. It accepts only the closed record `bindingDigest`, `controlPathsDigest`,
`sourcePathsDigest`, `evidenceDigest`, all prefixed SHA256. The first three must
match the shared exported `custody_digests` function: sorted compact ASCII JSON,
with both lists kept in passed order. Stages/providers must import that shared
codec rather than choose an independent Unicode convention. Missing provider,
None, booleans, wrong keys or wrong digests refuse before registration/admission.
The registry still performs its own conservative path/ancestor checks.

The record is meaningful ONLY from an externally qualified native provider that
rechecks actual namespace, inode and nested-hostmount facts. The library does not
implement another topology engine or synthesize this proof. Fabricated fixture
records are explicitly fake and do not qualify runtime custody or registration.
The production provider remains OPEN/unavailable before any executable wiring.
