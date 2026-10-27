# Fixed resume attempt ledger

This internal source component implements the durable attempt/budget part of the
efficiency contract. It is not imported by a CLI, route, broker, worker, service,
or scheduler. It has no send, wake, process, terminal, network, or model adapter.
Every receipt says automaticAction NONE. It cannot authorize a resume.

ResumeLedger requires an explicit private SQLite file in an existing trusted
service directory. Directory mode must be 0700, database mode 0600, with current
UID ownership, no symlink path and one database hard link. The directory's
ancestors and absence of untrusted writers remain operator custody requirements.
File-identity checks are defense in depth, not a race-proof filesystem sandbox.
No personal data or live instance directory belongs in a source/test checkout.

The accepted binding includes stable employee/goal/session IDs, both generations
and Goal transition sequence. The caller must obtain it from the accepted
canonical authority after authenticating the dedicated resume-service principal.
The ledger validates structure and exact equality; it does not authenticate the
caller, prove binding currentness, classify health or confer any grant.
Binding IDs retain the canonical ASCII `[A-Za-z0-9_.:-]` envelope, length 1–100,
without aliases or hashing. Operation keys remain separately bounded to 1–96
ASCII alphanumeric/underscore/hyphen characters, with an alphanumeric first
character. The eventual canonical reader still validates actual session identity.

reserve(binding, idempotency_key, server_now_ms) durably appends QUEUED before
any future effect. The fixed ceiling is three attempts in a rolling 30 minutes,
enforced separately for employee, goal and session IDs across generations. Every
reserved attempt counts, including later refusal/failure/uncertainty. A replacement
session or Goal cannot reset the employee limit. At the exact expiry boundary
the expired attempt leaves the rolling count. The fourth refusal creates one
durable deduplicated budget report per blocked interval; replays return that
original report. No configuration parameter can raise the ceiling.

advance appends a CAS transition bound to the exact stored tuple and expected
sequence/state. Supported stages are QUEUED, SUBMITTED, TURN_STARTED,
PROGRESS_OBSERVED, REFUSED, FAILED and UNCERTAIN. Reasons are fixed enums.
Reusing an idempotency key with different arguments refuses. An exact replay
returns the original receipt/time, never a newly stamped permission.

A target may have only one unresolved attempt across its stable employee, Goal
and session identities. reconcile_restart atomically changes every unfinished
attempt to UNCERTAIN; it never sends anything. This is conservative even for
a QUEUED record whose effect may never have started. Uncertainty remains fenced
after budget expiry and session replacement. There is deliberately no reset,
delete, re-enable or automatic reconciliation override.

SQLite serializes writers with BEGIN IMMEDIATE, full synchronous commits and
append-only attempt/event/report tables. A validated locked clock observation
survives semantic refusal: an operation savepoint rolls back partial attempt,
event and report changes, while the outer transaction commits only the floor.
Custody, corruption or persistence failure remains unavailable and cannot return
a successful semantic refusal receipt. Clock reversal refuses. All timestamps
must come from the trusted server clock, never a caller request. The component
does not attest clock accuracy or survive an authorized operator rolling the
entire ledger back to a valid older copy. The installed custody contract must
retain the original ledger and keep it out of automatic company-state rollback.
Corrupt/unknown ledgers refuse; no backup is adopted or silently repaired.
Before each operation, under the writer lock, bounded persisted attempts, events
and budget reports are validated against closed schemas and their stored columns.
Validation includes exact bindings, fingerprints, legal contiguous event history,
clock bounds and each report's backing rolling-budget evidence. Unknown fields,
versions, duplicate JSON keys, mismatched columns and malformed bodies return
fixed STORE_UNAVAILABLE before replay or CAS. Validation is a fresh bounded scan,
not an authority cache; production cost at the storage ceiling is unmeasured.

Storage is bounded: 4096 attempts/reports each, 16384 events, 128 unresolved
attempts, 2048-byte ASCII receipt bodies and 4096 SQLite pages. Exhaustion refuses;
there is no deletion that could erase a live quota or uncertainty fence. Lock
contention is bounded by a 250 ms SQLite timeout. Database errors expose fixed
codes without SQL, paths, bodies or exception strings.

Before any installed use, the remaining fixed-resume transaction must wire the
real canonical binding reader, dedicated service grant, per-target lock, fixed
message builder and safe FROZEN evidence. It must recheck generations, state,
pending input/dialog/jobs, sleep/off/vacation and grants after awaits and
immediately before submission, preserve uncertain-send reconciliation, and pass
independent source/security/privacy and the existing report-only/dry/canary
stages. No current source/test receipt proves this integration or deployment.

Run the owned synthetic controls with:

    PYTHONPATH=python python3 -B -m unittest tests.test_resume_ledger -v
