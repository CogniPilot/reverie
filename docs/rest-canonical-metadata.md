# Canonical REST metadata projection

This source component reads scalar metadata from the actual `CompanyStore` and
the actual runtime registry. The optional canonical Goal assembly attaches it to
its existing CompanyService/store and WebServer registry under the same custody
port. SessionManager uses the same scalar registry helper. No report route,
scheduler, timer, memory tool or effect adapter is added.

The original projection was reviewed on website597 plus accepted outer recovery
r2, tree `6db7ba3d7a220d0577d21d4de7642d4ec4745e64`. The current source composition
carries that component and the accepted canonical Goal service onto the newer
operator patch reconstruction; raw release commit binding remains separate. All recovery component bytes
are preserved. It uses the accepted `RecoveryMetadata` and
`RecoveryAuthoritySources['read']` types; no competing binding/lock/writer exists.

## What is implemented

- `CompanyStore.restEmployeeMetadata(owner, employee)` selects only the existing
  employee/owner/session IDs, desired-running/vacation and sleep/dream preferences
  directly from the canonical in-memory store. It never snapshots, clones or
  serializes profiles, memories, settings, cycle results or runtime recipes.
- `SessionManager.restSessionMetadata(session)` selects only current registry
  identity/owner, with a repeated identity check. It does not serialize a Session,
  probe a pane/process, or infer activity from busy/running/CPU/display status.
- `CanonicalRestMetadataReader.observe` requires trusted synchronous private-store
  custody before reading, checks owner/binding agreement, repeats the scalar reads
  and custody fences, and returns a frozen, bounded report. Missing or revoked
  custody and ambiguous/cross-owner/missing bindings return a fixed unavailable
  report without raw input/error text.

## What remains explicitly unavailable

The same canonical Goal store now supplies matching Goal ID, Goal generation,
transition sequence and actual Goal state. Multiple matching Goals remain unknown;
no latest Goal is guessed. A missing/changed canonical file witness yields unknown
Goal fields until ordinary store reload. Runtime session generation and source
revision remain unknown. It does not supply a complete pending-input/dialog/job/turn/
tool-wait/sleep witness. The report represents these as null, never invented
generation1, ACTIVE, revision0, empty-complete collections, no pending input or
zero active work. An ownerless record remains ownerId null; it is not assigned a
made-up owner. Missing desiredRunning stays null. Sleep/dream eligibility says
nothing about the current sleeping state or schedule/data/promotion grants.

The observed17-key shape shares the accepted recovery schema's field names, but
is deliberately a partial observation. Every report remains REPORT_ONLY,
UNAVAILABLE, UNPROVEN, automaticAction NONE. The exact accepted recovery `read`
seam, `recoveryRead`, returns null unconditionally: partial observations cannot be
promoted into a RecoveryPermit, even with test-supplied positive grant/FROZEN ports.
This is not the missing complete17-field canonical selector or real authority
adapter. It supplies current-source identity/preferences and available canonical Goal scalars only.

These reads are synchronous and reflect committed updates to the SAME store and
current session registry. They do not establish atomic cross-store consistency,
cross-process freshness, retirement/FROZEN evidence, a transaction lease or a
generation fence. Identity/preferences use the canonical in-memory state after init. A separately
changed disk file is visible only after reopening/reloading the canonical store;
the test explicitly demonstrates that limitation. Do not use this report as an
effect permit or add file polling to work around it. A restart creates a new
reader/store; no read cache, parallel status store or writer is introduced.

## Tests and next seam

Tests use real CompanyStore write/fsync/reopen and StateStore/SessionManager
objects in owned temporary directories. Only the Session process implementation
is replaced by a no-I/O test double, so registry creation needs no PTY/model.
Tests cover private-field access tripwires, unchanged bytes/file metadata after
reads and reopen, current OFF/vacation/preferences, owner changes, duplicate
bindings, session removal, incomplete generations, unavailable custody and
refusal through the accepted recovery authority. No live instance is read.

Run with the ordinary isolated test setup:

```
npm test -- test/rest-canonical-metadata.test.ts
```

Any later authority composition must preserve the accepted Goal private-store
reader and generation/currentness/after-await fences before providing missing fields. Reuse the one accepted outer recovery transaction and writer domain. Schedule,
resource, private/company data and promotion grants remain separate unavailable
adapters; no default schedule or speculative API is added here. Existing accepted
REST report-only behavior and custody interfaces are unchanged. No deployment or
activation follows from this source component.
