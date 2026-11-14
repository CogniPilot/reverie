# Docker-contained employee continuation

This application service prepares an explicitly approved new Docker destination
for a stopped employee laptop whose old placement cannot meet the selected
Docker resource policy. The old container stays stopped and unchanged. The
employee ID, full session ID, logical generation, provider conversation, account
selection and actual private HOME/Nix directories remain selected originals.

The controlplane selects the explicit backend `REVERIE_RUNTIME_BACKEND=boxed-docker-v1`
and a read-only fixed `/etc/reverie/boxed-runtime.json` manifest. The schema binds
one deployment, qualified worker image, client-capsule manifest, accepted source
images, resource-helper image and API URL. Native worker socket selectors cannot
be combined with this backend. Only the controlplane receives the fixed Docker
engine socket. Workers and resource/storage helpers receive no engine socket.

The fixed container-owned data directory initializes and retains a private
callback key. Its directory and key descriptors remain open; replacement or
permission drift revokes it. A callback token establishes one selected worker
identity, independently of CompanyService permissions. Existing scoped recovery
and office permissions remain necessary. An agent cannot approve resource edits.
The currently qualified callback adapter supports single-user instances.

A verified owner can review an optional legacy desired-policy DATA proposal and
approve policy together with recover-and-enter-office in one request. An absent
legacy mount supplies no defaults or authority. Generic employee updates cannot
edit Docker policy or bindings. The native CLI commands and thin profile GUI use
the same application decision owner and retained request; pending and held
outcomes remain visible. CLI exit zero means ready, not merely HTTP success.

The canonical CompanyStore records the operation before effects, helper creation
intent before CREATE, and actual container IDs before START. Observation can
inspect the original effects and finish their metadata, but cannot create/start
helpers, configure resources, write credentials or launch providers. A fresh
protected effect request can advance a helper known to be created but not yet
started. An unknown create/start or missing/failed helper acknowledgment never
becomes permission to repeat an effect.

Resource acceptance requires the same actual helper's successful completion and
fresh kernel observations. Docker hard memory, no-swap/PIDs, aggregate pool,
cpu.weight/cpuset and finite memory.high are separate checks. MemoryReservation
is not memory.high. A read-only storage holder retains original directory FDs
across host pathname replacement, and the actual destination must match those
held directories before provider startup. Paths and serialized IDs are only
correlation data.

The existing Session/mux services render the selected provider recipe. A private
one-attempt owner admits its first launch; saved Docker metadata can only attach
to an already-running matching provider. The fixed client capsule and managed
callbacks live outside private /nix. No shared Basic or hook secret is provisioned.

## Remaining integration and acceptance gates

Source tests do not qualify an installed employee. The composed image, actual
PTY-to-fixed-engine path, provider command, bound callback transport and
owner-authenticated workflow need separate installed qualification. Normal wake
can attach to a freshly verified running boxed provider. Restarting a stopped
destination/provider after a host reboot needs a distinct retained effect
continuation; it does not fall back to local/native execution. Fresh employee
creation and successful plan moves with boxed bindings remain separate owning
work, alongside the full company/plan/permission CI scenario. This slice is not a
claim that those workflows are complete.
