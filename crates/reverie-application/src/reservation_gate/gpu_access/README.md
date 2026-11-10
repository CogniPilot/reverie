The owner-local GPU service preserves the existing status, request/CAS and cold
boundary order from `worker_gpu_access.py`. InstallingBroker supplies its actual
Runtime and optional Gate. The canonical J consumer must call cold_boundary only
after image refresh and before ordinary admission, excluding attach-only and
protected source joins. The C transport still owes its actual owner-UID check;
this service adds no endpoint or OfficeAPI permission.

A proposed request is data. Real admission, current-employee observations,
current effective hashes, actual native census/custody, idle journal/headroom,
complete worker validation and peer-policy equality precede publication. Legacy
SID grants remain authoritative. Running seats and installed raw-config consumers
keep requests queued. Absent queues bypass all native/current observations.

The only RAM publisher consumes a private handoff minted after both actual
config/binding CAS writers and their checked finalizers. It holds the real
lifecycle, Gate state, active context, current snapshot and binding locks in that
order; all fallible guards/checks and tuple derivation end before assignment.
Binding is not independently mutable through any API. Only this same active
transition's real pending owner and exact census can pass the pending guard.

After any possible pending publication, all failures retain the actual record and
durable fence. Terminal file/parent/current observations run after checked
admission finalization; pending identity is the last file check and unlink is
never retried. A failed record prevents later admission and completion ACK, while
native settlement is still attempted and dual failures are preserved. No source
file rollback, plan/journal rewrite, process restart or device workload exists.
CAS remains cooperative with the installing lifecycle, not atomic protection
against arbitrary same-UID editors between named checks and rename/unlink.

One explicit preservation correction closes an observed old-source gap: terminal
CDI identity is tied to the last bytes actually read/parsed/validated, rather than
a fresh stamp taken after the second engine-info query. A changed file before
publication refuses without effects; a changed file after publication retains
pending and requires reconciliation. This changes no accepted YAML/device schema.

Tests use actual owned files, admission flocks, CAS/fsync/close producers and
private synthetic kernel/driver/engine observation ports. They do not qualify
live GPUs, installed device custody or the eventual wire/launch consumer.

The standalone preflight now composes the shared observers through the native
`reverie_application::gpu_preflight` service. `worker-gpu-support.nix` selects
its fixed `reverie-worker-gpu` executable. Its byte-JSON queries, complete CDI
path values and report serialization are separate from the queue's narrower
projection. Legacy services still import the Python helper module. This does
not establish installed GPU/image qualification or retire the old broker.

Actual admission precedes the purpose-private lifecycle mutex wait, matching the
existing creation-budget caller. That wait retains the original operation end;
it cannot release another thread's guard or renew the budget. Publication still
holds lifecycle before Gate state/context/current/binding. The canonical cold
caller must not hold lifecycle while waiting for admission.
