# Hands learning log persistence

This dedicated store preserves the broker `_LearningLog` schema: failures,
binding, counters and telemetry_origin; harness hands and SELF_REPORTED_RESULT.
It neither uses the memory/effect ledger nor interprets rows as authority.
Defaults have one Core owner: 2048 entries, seven-day retention, 256 SQLite pages,
31-bit saturating publication counters and the source clock ceiling. Rollback
journal/temporary overhead is additional to the main database page bound.

Each call pins a readable nofollow directory and regular owned single-link
owner-only database file, opens SQLite through `file:/proc/self/fd/N?mode=rw`,
and checks the original named directory/file plus SQLite's resolved main file
before any writable pragma or SQL. There is no SQLite CREATE pathname fallback.
The employee parent is already checked by the Host; only fixed hands is created
here. Named open_existing creates neither directory nor DB and closes the
measured report precheck→O_CREAT race; existing-file initialization/expiry
remains source-compatible. Source file/directory owner-only modes are preserved; protected report
precheck separately requires exact DB0600. FIFO leaves are opened nonblocking
before type validation, with no difference for valid regular files.

Connections use DELETE journal, FULL synchronous, secure_delete and a 50-ms busy
wait. Expiration precedes duplicate detection; duplicate root IDs accept exactly
the same principal/harness/tool/exit/category, conflicting rows return false.
Eviction uses t,execution ordering. Malformed report rows are omitted exactly as
source; invalid UTF-8 SQLite TEXT fails the whole read as Python fetchall does,
even if another field would subsequently omit that row. Stored unknown executable
names are never emitted. Counter types/clamping and provenance/binding refusal
match source, including complete-fetch decoding, last duplicate values and
exact Python key lookup independently of SQL column collation. Finalizers run
in original order: resolved-name anchor, SQLite, data file, directory.
Transaction/commit/rollback and checked native closes preserve
primary plus secondary failure evidence.

LearningLogs is a real resource owner, not a permission callback. Two simultaneous
calls derive from the producer/report concurrency. Refused sqlite3_close retains
its opaque Connection in this owner before admission is released; a later open
refuses, even if an earlier caller is paused or discards its outward error. An
already-admitted sibling cannot reopen after the fence. No raw SQL/Connection
accessor exists. Drop is best effort, not a shutdown/release acknowledgement;
callers must retain the manager and compose actual handler lifetime. No automatic
retry, foreign-name cleanup, or crash rollback claim is made. `/proc/self/fd` and
the Linux custody adapters are explicit platform requirements.
