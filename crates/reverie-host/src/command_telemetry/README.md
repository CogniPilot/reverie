# Native command telemetry

`CommandTelemetry::capture(runtime, captured_config)` ports the actual broker's
constructor-selected optional service. It retains the **same** installed-engine
Arc as Runtime. Disabled/absent/null config skips UID, path, engine and sink work;
it is a real configured feature state, not a missing-service fallback.

The enabled order is UID equality, canonical/private state directory, materialize
all configured sources and legacy `[0-9a-f-]{36}` session paths (raw source type
refusal remains after legacy enumeration), reject source/sink
overlap/aliases, fixed filtered engine census, complete inspect rows and mount
sources, then create the fixed `command-telemetry` sink. Each engine call uses
the existing 20-second/combined-4-MiB supervisor and original first-stop clamp;
there is no new whole-constructor timeout, raw command or alternative runner.
All mounted sources, including readonly sources and volume backing paths, count.

The actual final create caller must retain a genuine `Arc<CommandTelemetry>` and
call `check_create_args(&same_runtime, &complete_metadata_text_argv)` **after**
current storage intent and all account/Nix mount appends, immediately before
create (Python worker.py2100–2104). Parsing every mount precedes all filesystem
source checks. Unknown argv codepoints remain data; no lossy scalar conversion.
This check and its Arc origin are neither authorization nor start permission.

`observe` uses the Office constructor's checked SID and the original 512-byte
closed event. It obtains the company/storage/current-start binding before the
producer lock, repeats it under the lock, opens the lazy log, then repeats it
before writing. Historical edges cannot authorize this producer. `report` retains
its original three observations. `report_employee` includes retired rows, checks
owner before and after report I/O, returns no_data only for missing employee dir,
and refuses missing DB without recreating it. A named existing-only open also
refuses deletion between precheck/open without creating directories or a DB.
This narrow preservation correction deliberately closes the measured legacy
ready/empty-report recreation race; both old Python/Rust RED controls remain.
Existing DB table initialization,
expiry and pragma maintenance follow the original `_LearningLog` behavior.

`command_failure_report` uses a nonblocking independent report lock, exact selected
employee order, closed counts/counters and the original 20-group sort/truncation
and 256-KiB response bound. It never holds the producer mutex during storage I/O.
The T transport must independently authorize actual peer UID; API/browser owner
and grant checks remain outside this service. Telemetry is SELF_REPORTED_RESULT,
not proof a command ran. Raw commands, diagnostics, path and owner text never
enter output counts or the database.

The dedicated Store LearningLogs owner admits at most the two source producer/
report operations. It retains actual refused-close SQLite connections before
releasing call admission and fences new DB opens. Quiet result conversion runs
inside the source producer/report guards. A close failure after commit may leave
the event persisted; no rollback, safe replay or global cleanup ACK is claimed.
Pending/unconfirmed observations do not exclude a crossing new service call.
The installing broker must retain this object and join its actual handlers when
composing shutdown. Kernel/filesystem/SQLite close latency is not a hard time
bound. Same-UID noncooperating rename attacks are outside the source's cooperative
filesystem trust boundary; held/named checks are witnesses, not atomic exclusion.

Production invokes no Python. Frozen reference JSON contains 127 actual Python
codec/argv/report vectors, 18 real-owned-filesystem constructor recipes, 19 SQLite
cases and three owner-race recipes. Host controls additionally exercise actual
Rust child argv, real SQLite dedupe, retired reporting, FIFO/public-mode refusal
and current owner changes. Store tests force a real refused sqlite3_close in an
isolated owned process and retain its connection across a paused admitted caller.
The three invalid UTF-8 SQLite TEXT acceptance bugs and initial close-fence race
were found before freeze; their original failing evidence remains durable.

Consumer work remains: InstallingBroker bootstrap must capture this real service;
its actual final create, Office producer and protected T handler must consume it.
No selector, endpoint, live engine probe or deployment changes here. The generic
hands `execution_observer`/other harness adapters remain separately unported;
this is the complete **broker CommandTelemetry** purpose. Shared iterative JSON
readers preserve actual grammar/number/text policies; CPython implementation
stack-exhaustion behavior is not an invented new schema-depth cap.
