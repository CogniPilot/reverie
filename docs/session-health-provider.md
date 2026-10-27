# Read-only session health metadata provider

The server registers `GET /api/session-health/:id/metadata` behind the existing
verified-owner middleware and exact current session ownership. It accepts no
query/body/actor claims. The route adds no agent/service read permission or grant.
Responses are no-store, below 2 KiB, limited to one read per second per session,
with at most 128 recent admissions and a 200 ms synchronous read budget. There is
no queue, background observer, process launch, socket request or model call.
JavaScript cannot preempt a synchronous trusted reader; exceeding the budget
refuses its result. Native load/latency acceptance remains a release gate.

## Authoritative source and supported fields

`ServerHealthMetadataProvider` consumes a purpose-distinct
`metadataBinding(sessionId)` interface, the SAME server CompanyStore, and the
server's existing session registry. `CanonicalHealthMetadataReader` has no Goal
`binding`, signing, authenticate or action method. It allocates no session/Goal
generation, creates no parallel store and modifies no Goal record. The actual
Goal assembly attaches this reader to the same CompanyService store, registry,
retirement service and mandatory custody port. Missing provisioning/attachment
refuses (503); low-level legacy Goal embedding ports do not enable health reads.

`CompanyStore.healthMetadataSnapshot()` copies only selected identifiers,
generations, owner intent, Goal enum/sequence/times and the final receipt's matching
metadata. It never clones the company memory arrays or reads objective, blocker
prose, next-action, prompt, receipt body, argv, environment, or terminal content.
The scalar method checks a file/state witness before and after projection.
Ordinary canonical init/snapshot capture a stable regular single-link inode/time
stamp around their existing read; a successful locked canonical commit updates
the witness. The health endpoint itself performs metadata stats only, never a
private-content reload or full schema parse/clone. Missing, replaced or externally
modified canonical state refuses until an ordinary canonical operation establishes
a fresh witness; health does not trigger that operation or retry. The stamp is a
freshness fence, not a substitute for real private custody or mount isolation.

The accepted active `GoalCanonicalAuthority.binding` is unchanged. It still denies
stopped/vacation/nonrunning/retired bindings for Goal authentication. The separate
health reader can report STOPPED/VACATION intent when canonical generation, exact
owner and an existing registry object match, without calling isRunning. Missing
registry, retired, ambiguous/migrating or revoked-custody targets stay unavailable.
No process liveness follows from registry presence or desired-running intent.

Canonical employee/session generation and current Goal tuple are returned only
when they match the metadata-only binding and registry owner. Duplicate identities,
in-flight binding migration, missing generations or replaced runtime objects
refuse. Multiple active Goals are not resolved by choosing the newest: Goal and
progress remain unknown. Metadata is checked again before returning, including
Goal sequence/state, employee intent and the metadata-only binding.

Recent semantic progress is exposed only from the current canonical Goal's final
receipt when its sequence, generation, session generation, state and timestamps
match the current record. Future, stale, absent or mismatched receipt metadata
becomes null/UNKNOWN. This is an authenticated canonical receipt observation,
not independent proof of tool execution, process liveness or task completion.

There is no supported broker process-incarnation receipt, pending-input receipt,
compaction phase or tracked-job budget source in this increment. Those fields
remain UNKNOWN/null; registry presence, a surviving PID, display busy flags and
terminal activity are never substituted. The observation therefore remains
AMBIGUOUS/UNKNOWN_METADATA with automaticAction NONE. It supplies real bounded
metadata without manufacturing the complete evidence required by the separately
reviewed health classifier. No FROZEN proof is created. This metadata endpoint
is separate from that classifier's complete-evidence endpoint; it is not a second
Goal/status authority store. A future provider can fill additional signals only
through a separately reviewed supported metadata receipt contract.

## Integration and rollback

This source composes accepted Goal9b814 and the sealed health interface on the
exact appearance464f base. It preserves the eighth WebServer/startWebServer
`GoalServerInput`; there is no competing health argument/configuration. The merge
interface for the separately owned normal Goal bootstrap is the existing
`createGoalServerAssembly(...).attach(...)` plus its read-only `metadataReader`
property. Attach constructs both purpose-distinct readers over one actual store;
do not create credentials, generations, a second CompanyStore, or a new auth
reader to satisfy health. The ordinary private Goal bootstrap/fixed-office signer
delivery remain missing in this source; no mutable bootstrap branch was imported.
Default no-provisioning remains unavailable. Later composition needs independent
review and must preserve current UI, Bots, art and ordinary owner/routine policy.

Owned fixtures cover actual r3/disk-nonce/OfficeAPI/CLI WebServer assembly, real
owner middleware and actual store privacy traps. Whole-store snapshot/clone,
memory/profile/objective reads and process calls are poisoned during metadata
reads. Stopped/vacation remain metadata-only, real retirement/cross-owner/custody
denials and generation/file-change races are exercised. These are synthetic
fixtures, not custody or installed evidence. Native build, image and read-only
canary remain independent gates. An installed canary must verify owner scope,
UNKNOWN semantics, current binding, privacy and zero effect calls before rollout
is counted live. Recovery is a later separate transaction. Rollback removes only
provider registration/source (or supplies no binding reader); no persisted
metadata, grants, jobs or resource policy require migration or reversal.
