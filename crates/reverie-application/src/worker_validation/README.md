# Ordered worker configuration validation

`validate_captured` composes the complete readonly `worker.validate_config`
pipeline. `load_owner_config` first captures and decodes the named owner file,
then uses that same service. Neither function starts a broker, changes a
selector, initializes storage or grants an owner/start permission.

The application preserves the original observation sequence: header;
helper/memory/reservation options; OPS binding; browser and resource-actor
selectors; telemetry/GPU/perf/resource maps; enabled-rootless qualification;
Goal path; base/path/maintenance and per-mount declarations plus immediate
strict source observations; attachments; lease option; cold policy. Existing
core/contracts owners define the rules. The schema callback permits the first
mount's native failure to precede a malformed later declaration. Returned stage
and cause codes are closed diagnostics, rather than raw private exception text.

`WorkerEnvelope` alone remains partial envelope data. Only this application's
privately constructed `ValidatedWorkerSnapshot` records that all validator
clauses succeeded. Its source paths and native metadata are snapshots with no
held descriptors or enduring custody. Fresh admission, current company identity,
owner authorization and actual mount/process/engine checks remain separate at
the consuming effect. A snapshot must never be accepted as those proofs.

The owner loader preserves `Path.read_text()` UTF-8 and universal newline
semantics followed by Python `json.loads(str)`: last duplicate wins, nonfinite
dormant values survive and integer tokens retain the frozen 4300-digit bound.
It does not accept a BOM or auto-detect UTF-16/32. The existing duplicate-free
worker hash decoder is unchanged. Owner-only regular files may have hard links
or symlinked ancestors as before. The reader additionally refuses observed
replacement/edit races, opens the leaf without following a replacement symlink,
checks final readback and closes explicitly. It inserts no byte limit, lock,
default or persistent record. Native read and finalizer failures are retained.

The shared iterative decoder intentionally does not reproduce CPython's
call-stack-dependent exhaustion failures. Compatibility covers grammar,
number/text behavior, schema and observable readonly ordering, with the named
file/transport bounds. Supporting deeper otherwise-valid data preserves all
previously accepted inputs; there is no interpreter process or fallback.

OPS validates its actual private configuration, optional authorization and Goal
metadata, with nofollow anchored ancestors, owner-only single-link files and the
original 64-KiB bounds. Exposure checks include configured mount sources,
scratch, employee storage and console account roots. It reads no request key,
invokes no engine and creates no OPS authorization. Its daemon's installed
source/manifest/authentication/runtime custody is a different obligation.
Browser/resource-actor selector checks preserve non-strict pathlib resolution,
including nonexistent tails and Python string provenance. Cold policy performs
fresh non-strict source resolution for each selected host lease directory;
earlier strict mount snapshots do not substitute for those reads.

## Runtime consumers still requiring migration

Configuration validation does not replace these Python runtime units:

| Consumer | Remaining boundary |
| --- | --- |
| `worker.py::Broker`, launch and reload | J/L/C/G/T transports, host admission/storage leases, engine effects, OfficeAPI, shutdown and rechecks |
| `GoalBrokerBootstrap` | Lazy private policy identity, real running/stopped inventory, peer/process namespaces, unexposed keys and nonce custody; original-program authority remains unavailable by default |
| `ops_service` | Installed daemon source/manifest binding, authenticated transport, protected keys/nonce store, website effects and repeated live/stopped mount custody |
| `BrowserJobRequests` | Actual policy/artifact/program qualification, common NativeObserver custody and reservation admission, private request state and fixed execution |
| `ResourceActorService`/`InstalledFacts` | Per-connection installed immutable facts, exact native worker-client manifest/program binding, protected launch join and phase acknowledgements |
| `CommandTelemetry` | Current employee/storage brackets, engine inventory isolation, private SQLite producer/report stores and self-reported event handling |
| `worker_cold_tmp` | Kernel mount/reference census, actual storage/build leases, pending fences, bounded clear or retain-and-replace effects and recovery |
| `ReservationGate` | Durable binding/pending state, admission/lifecycle and reconciliation; the separately ported NativeObserver is readonly data, not this gate |
| `WorkerChatImages`, resume/provider health | Real per-seat namespace/storage/program observations and bounded runtime transports |

Existing file-loader consumers also include worker service/install/upgrade,
transport maintenance/upgrade, image preparation/switch, resource preparation,
resource-actor refresh, perf/resume clients, owner terminal lifecycle/website,
provider-health checks and employee/Nix migration. These call the existing
Python entry point until a complete reviewed consumer migration selects this
application service. Pure callers such as `worker_image.PrivateConfig` and
resource preparation must use `validate_captured`, preserving their own held
publication/admission/finalization guards. No production entry point or package
selection changes in this cohort.

The inert reference corpus was captured from actual unpatched Python 3.13 with
task-owned files. It covers 166 optional/native validator cases, 35 real loader
cases, 22 paired-failure ordering cases, 20 private OPS decoding cases, eight
lazy Goal binding iteration cases and 25 non-strict resolver cases. Tests
also inject owned read/replacement/close faults. A matching reference result is
not a qualification of a live broker, company, engine or deployment.
